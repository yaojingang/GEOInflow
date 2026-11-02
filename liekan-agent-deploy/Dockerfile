FROM node:22.23.4-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914
WORKDIR /app
COPY agent.mjs container.mjs LICENSE ./
RUN mkdir -p /var/lib/liekan-agent && chown 65532:65532 /var/lib/liekan-agent \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
USER 65532:65532
ENTRYPOINT ["node", "/app/container.mjs"]
CMD ["run"]
