export const parseHttpUrl = (value: string): URL | null => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
};

export const isHostAllowed = (
  host: string,
  allowedHosts: Iterable<string>
): boolean => {
  const normalized = host.toLowerCase();

  for (const allowed of allowedHosts) {
    const candidate = allowed.toLowerCase();
    if (normalized === candidate || normalized.endsWith(`.${candidate}`)) {
      return true;
    }
  }

  return false;
};

export const isSourceUrlAllowed = (
  value: string,
  allowedHosts: Iterable<string>
): boolean => {
  const url = parseHttpUrl(value);
  return Boolean(url && isHostAllowed(url.hostname, allowedHosts));
};
