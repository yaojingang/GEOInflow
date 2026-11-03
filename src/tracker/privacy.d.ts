/** Shared by the browser tracker and collector; campaign parameters remain available. */
export declare function sanitizeCollectionUrl(value: string, base?: string): string;
/** Preserve explicit tracker paths and exclusions while redacting outbound values. */
export declare function sanitizeTrackerUrl(value: string): string;
