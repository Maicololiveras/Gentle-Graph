export const projectionArgs = ["grep","--untracked","-I","-z","-o","-E","-f","-","--",
  ...["ts","tsx","js","jsx","mts","cts","mjs","cjs","svelte"].map(ext=>"*."+ext)];
export const projectionPattern = `["']([.]{1,2}(/[^"']*)?|[$]lib/[^"']*)["']\n`;
