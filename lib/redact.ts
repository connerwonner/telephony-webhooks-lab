export const phoneSuffix = (p?: string) => (p ? `***${p.replace(/\D/g, "").slice(-4)}` : "unknown");
