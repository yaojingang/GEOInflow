#!/bin/sh
set -eu
umask 077
fail() { printf '%s\n' "$1" >&2; exit 1; }
[ "$(id -u)" = 0 ] || fail '请使用安装页面生成的 sudo 命令。'
url='';code='';log='';mode='install';source=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --url) url="$2";shift 2;; --code) code="$2";shift 2;; --log) log="$2";shift 2;;
    --upgrade) mode='upgrade';source="$2";shift 2;; --uninstall) mode='uninstall';source="$2";shift 2;;
    *) fail '安装参数无效。';;
  esac
done
if [ "$mode" != install ]; then
  case "$source" in *[!a-f0-9-]*|'') fail '来源标识无效。';; esac
  [ "${#source}" = 36 ] || fail '来源标识无效。'
  [ -f "/etc/liekan-agent/$source.json" ] || fail '未找到此来源的配置。'
fi
if [ "$mode" = uninstall ]; then
  systemctl disable --now "liekan-log-$source.service"
  rm -f "/etc/systemd/system/liekan-log-$source.service"
  systemctl daemon-reload
  printf '%s\n' '采集服务已卸载。加密缓冲和配置已保留；请在网站设置中断开此来源。'
  exit 0
fi
case "$url" in *[!a-zA-Z0-9./:_-]*|'') fail '接收地址无效。';; https://*) ;; *) fail '需要 HTTPS 接收地址。';; esac
. /etc/os-release
case "$ID:$VERSION_ID" in ubuntu:22.04|ubuntu:24.04|debian:12) ;; *) fail '支持 Ubuntu 22.04/24.04 或 Debian 12。';; esac
command -v systemctl >/dev/null || fail '需要 systemd。'
for command in curl openssl sha256sum tar getent setpriv runuser useradd usermod; do command -v "$command" >/dev/null || fail "缺少 $command，请先安装。";done
case "$(uname -m)" in x86_64) arch=x64;; aarch64|arm64) arch=arm64;; *) fail '暂不支持此处理器。';; esac
if [ "$mode" = install ];then
  case "$code" in *[!a-zA-Z0-9_-]*|'') fail '配对码无效。';;esac
  [ "${#code}" = 43 ] || fail '配对码无效。'
  if [ -z "$log" ]; then
    printf '当前网站的 Nginx/Apache Combined 日志绝对路径：' >/dev/tty
    IFS= read -r log </dev/tty
  fi
  case "$log" in /*) ;; *) fail '日志需要绝对路径。';;esac
  [ -f "$log" ] && [ ! -L "$log" ] || fail '日志需为本机常规文件。'
  log=$(readlink -f "$log") || fail '日志路径无法解析。'
  case "$log" in /home/*|/root/*|/run/user/*|/tmp/*|/var/tmp/*) fail '该日志路径受采集服务隔离保护，请将网站日志放到专用的 /var/log 目录并设置只读用户组。';;esac
  log_group=$(stat -c '%G' "$log")
  [ "$log_group" != root ] && [ "$log_group" != UNKNOWN ] || fail '请先为该网站日志设置专用只读用户组，再执行安装。'
  log_gid=$(stat -c '%g' "$log")
  setpriv --reuid nobody --regid "$log_gid" --clear-groups test -r "$log" || fail '日志用户组无法读取该文件，请先配置只读权限。'
  setpriv --reuid nobody --regid "$log_gid" --clear-groups test -r "$(dirname "$log")" || fail '日志用户组无法读取轮转目录，请先配置目录权限。'
fi
temp=$(mktemp -d)
trap 'rm -rf "$temp"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
fetch() { curl -fsS --proto '=https' --tlsv1.2 --max-time 120 "$url/liekan-agent/$1" -o "$temp/$1"; }
fetch manifest.json;fetch manifest.sig
cat > "$temp/trusted.pub" <<'PUBLIC_KEY'
__PUBLIC_KEY__
PUBLIC_KEY
openssl pkeyutl -verify -pubin -inkey "$temp/trusted.pub" -rawin -in "$temp/manifest.json" -sigfile "$temp/manifest.sig" >/dev/null 2>&1 || fail '安装清单签名校验失败。'
# Read only the fixed artifact name and checksum from our signed canonical manifest.
checksum=$(sed -n "s/.*\"$arch\":{\"file\":\"agent-linux-$arch.tar.gz\",\"sha256\":\"\([a-f0-9]*\)\"}.*/\1/p" "$temp/manifest.json")
[ "${#checksum}" = 64 ] || fail '安装清单格式无效。'
fetch "agent-linux-$arch.tar.gz"
printf '%s  %s\n' "$checksum" "$temp/agent-linux-$arch.tar.gz" | sha256sum -c - >/dev/null || fail '安装包校验失败。'
mkdir "$temp/package"
tar -xzf "$temp/agent-linux-$arch.tar.gz" -C "$temp/package" --no-same-owner
[ -x "$temp/package/bin/node" ] && [ -f "$temp/package/agent.mjs" ] || fail '安装包不完整。'
version=$($temp/package/bin/node -e 'process.stdout.write(process.versions.node)')
[ "$version" = '22.23.4' ] || fail '运行时版本不匹配。'
mkdir -p /opt/liekan-agent/releases /etc/liekan-agent /var/lib/liekan-agent
if [ "$mode" = install ];then
  source=$("$temp/package/bin/node" "$temp/package/agent.mjs" pair --url "$url" --code "$code" --log "$log" --directory /var/lib/liekan-agent) || fail '配对失败。请重新生成安装命令。'
  case "$source" in *[!a-f0-9-]*|'') fail '配对响应无效。';;esac
  [ "${#source}" = 36 ] || fail '配对响应无效。'
  account="liekan-$(printf '%s' "$source" | tr -d '-' | cut -c1-24)"
  getent passwd "$account" >/dev/null || useradd --system --user-group --no-create-home --shell /usr/sbin/nologin "$account"
  usermod -a -G "$log_group" "$account"
  runuser -u "$account" -- test -r "$log" || fail '采集用户无法读取日志；配置已保留，请检查文件与目录权限。'
  mv "/var/lib/liekan-agent/$source/config.json" "/etc/liekan-agent/$source.json"
  chown "root:$account" "/etc/liekan-agent/$source.json";chmod 640 "/etc/liekan-agent/$source.json"
  chown -R "$account:$account" "/var/lib/liekan-agent/$source"
fi
chmod 755 /opt/liekan-agent /opt/liekan-agent/releases /var/lib/liekan-agent
chmod 711 /etc/liekan-agent
chmod 755 "$temp/package" "$temp/package/bin"
chmod 555 "$temp/package/bin/node"
chmod 444 "$temp/package/agent.mjs" "$temp/package/LICENSE"
release="$(date +%s)-$arch"
mv "$temp/package" "/opt/liekan-agent/releases/$release"
previous=$(readlink "/opt/liekan-agent/$source" || true)
unit="/etc/systemd/system/liekan-log-$source.service"
if [ "$mode" = upgrade ] && [ -f "$unit" ]; then cp "$unit" "$temp/previous.service"; fi
ln -s "/opt/liekan-agent/releases/$release" "/opt/liekan-agent/$source.next"
mv -Tf "/opt/liekan-agent/$source.next" "/opt/liekan-agent/$source"
account="liekan-$(printf '%s' "$source" | tr -d '-' | cut -c1-24)"
cat > "/etc/systemd/system/liekan-log-$source.service" <<SERVICE
[Unit]
Description=Liekan website log collector $source
After=network-online.target
Wants=network-online.target
[Service]
Type=exec
User=$account
Group=$account
ExecStart=/opt/liekan-agent/$source/bin/node /opt/liekan-agent/$source/agent.mjs run --config /etc/liekan-agent/$source.json
ExecStartPost=/opt/liekan-agent/$source/bin/node /opt/liekan-agent/$source/agent.mjs ready --config /etc/liekan-agent/$source.json --pid \$MAINPID
Restart=on-failure
RestartSec=10
UMask=0077
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
CapabilityBoundingSet=
ReadWritePaths=/var/lib/liekan-agent/$source
TimeoutStopSec=45
[Install]
WantedBy=multi-user.target
SERVICE
activate_service() {
  systemctl daemon-reload && systemctl enable "liekan-log-$source.service" && systemctl restart "liekan-log-$source.service"
}
if [ "$mode" = upgrade ]; then
  if ! activate_service; then
    if [ -n "$previous" ]; then
      ln -s "$previous" "/opt/liekan-agent/$source.rollback"
      mv -Tf "/opt/liekan-agent/$source.rollback" "/opt/liekan-agent/$source"
      if [ -f "$temp/previous.service" ]; then cp "$temp/previous.service" "$unit"; fi
      systemctl daemon-reload || true
      systemctl restart "liekan-log-$source.service" || true
    fi
    fail '升级启动失败，已恢复此前运行包。'
  fi
else
  activate_service || fail '采集服务启动检查失败。配置已保留，请检查日志权限和服务状态。'
fi
printf '%s\n' "采集服务已安装：$source" '可回到网站设置查看连接、真实接收和处理状态。'
