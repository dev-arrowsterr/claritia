// Device type, browser and OS from the user agent (and client hints when sent). Coarse on purpose.

export type Agent = { device_type: "desktop" | "mobile" | "tablet" | "other"; browser: string; os: string };

export function parseAgent(ua: string, chMobile?: string | null): Agent {
  const os = /Windows/.test(ua)
    ? "Windows"
    : /iPhone|iPad|iPod/.test(ua)
      ? "iOS"
      : /Android/.test(ua)
        ? "Android"
        : /CrOS/.test(ua)
          ? "ChromeOS"
          : /Mac OS X|Macintosh/.test(ua)
            ? "macOS"
            : /Linux/.test(ua)
              ? "Linux"
              : "Other";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /SamsungBrowser/.test(ua)
        ? "Samsung"
        : /Firefox\/|FxiOS/.test(ua)
          ? "Firefox"
          : /Chrome\/|CriOS/.test(ua)
            ? "Chrome"
            : /Safari\//.test(ua)
              ? "Safari"
              : "Other";
  const device_type =
    /iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua))
      ? "tablet"
      : chMobile === "?1" || /Mobi|iPhone|iPod/.test(ua)
        ? "mobile"
        : os === "Other"
          ? "other"
          : "desktop";
  return { device_type, browser, os };
}
