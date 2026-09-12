/** Remove ```json / ``` fences (the rule every caller used to apply by hand). */
export function stripCodeFences(text: string): string {
  return text.replace(/```json|```/g, "").trim();
}

/**
 * The first balanced `{...}` in the text, string-literal aware, so prose
 * before or after a JSON reply does not break JSON.parse. Returns the
 * stripped text when no object starts, and the tail from the first brace
 * when the object never closes (JSON.parse then fails with a clear error).
 */
export function extractJsonObject(text: string): string {
  const s = stripCodeFences(text);
  const start = s.indexOf("{");
  if (start < 0) return s;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return s.slice(start);
}
