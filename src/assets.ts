export const ASSET_PREFIX = "https://uploads.linear.app/";

export interface AssetMatch {
  start: number;
  end: number;
  url: string;
  name: string;
  isImage: boolean;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function maskCodeRegions(text: string): string {
  if (!text.includes("`")) return text;
  const out = text.split("");
  const mask = (from: number, to: number) => {
    for (let k = from; k < to; k++) out[k] = ".";
  };
  for (let i = 0; i + 3 <= text.length; ) {
    if (!text.startsWith("```", i)) {
      i++;
      continue;
    }
    const close = text.indexOf("```", i + 3);
    const end = close < 0 ? text.length : close + 3;
    mask(i, end);
    i = end;
  }
  for (let i = 0; i < out.length; ) {
    if (out[i] !== "`") {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < out.length && out[j] !== "`") j++;
    const end = Math.min(j + 1, out.length);
    mask(i, end);
    i = end;
  }
  return out.join("");
}

export function extractAssets(text: string, prefix = ASSET_PREFIX): AssetMatch[] {
  const masked = maskCodeRegions(text);
  const url = `(${escapeRegExp(prefix)}[^)\\s]+)`;
  const re = new RegExp(`(!?)\\[([^\\]]*)\\]\\(${url}\\)`, "g");
  const out: AssetMatch[] = [];
  for (const m of masked.matchAll(re)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const isImage = m[1] === "!";
    const nameStart = start + m[1].length + 1;
    const urlStart = nameStart + m[2].length + 2;
    out.push({
      start,
      end,
      name: text.slice(nameStart, nameStart + m[2].length),
      url: text.slice(urlStart, urlStart + m[3].length),
      isImage,
    });
  }
  return out;
}

export function splice(text: string, matches: AssetMatch[], replacements: string[]): string {
  let out = "";
  let cursor = 0;
  matches.forEach((m, i) => {
    out += text.slice(cursor, m.start) + replacements[i];
    cursor = m.end;
  });
  return out + text.slice(cursor);
}
