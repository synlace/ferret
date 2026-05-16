// ---------------------------------------------------------------------------
// upsertToken — add, update, or remove a qualifier token in a raw query string
//
// Usage:
//   upsertToken("login method:GET", "method", "POST")
//     → "login method:GET,POST"
//
//   upsertToken("login method:GET,POST", "method", "GET")   // toggle off
//     → "login method:POST"
//
//   upsertToken("login method:GET", "method", "GET")        // toggle off last value
//     → "login"
//
//   upsertToken("login", "method", "GET")                   // add new qualifier
//     → "login method:GET"
// ---------------------------------------------------------------------------

/**
 * Toggle a single value within a qualifier token in the query string.
 * If the value is already present it is removed; otherwise it is added.
 * The qualifier is removed entirely when its value list becomes empty.
 *
 * @param query     Current raw query string
 * @param qualifier Qualifier name, e.g. "method", "mime", "ext"
 * @param value     The value to toggle, e.g. "GET", "json"
 * @param negated   Whether this qualifier should be negated (prefix -)
 */
export function upsertToken(
  query: string,
  qualifier: string,
  value: string,
  negated = false,
): string {
  const prefix = negated ? "-" : ""
  const qualLower = qualifier.toLowerCase()

  // Regex to find an existing token for this qualifier (negated or not)
  // Matches: optional -, qualifier:, then a quoted or unquoted value
  const tokenRe = new RegExp(
    `(-?)${qualLower}:("(?:[^"\\\\]|\\\\.)*"|[^\\s]*)`,
    "i",
  )

  const match = tokenRe.exec(query)

  if (!match) {
    // Qualifier not present — append it
    const trimmed = query.trim()
    return trimmed ? `${trimmed} ${prefix}${qualLower}:${value}` : `${prefix}${qualLower}:${value}`
  }

  // Qualifier already present — parse its current values
  const existingNegated = match[1] === "-"
  const rawValues = match[2].startsWith('"')
    ? match[2].slice(1, -1)
    : match[2]

  const currentValues = rawValues.split(",").map(v => v.trim()).filter(Boolean)
  const valueLower = value.toLowerCase()
  const idx = currentValues.findIndex(v => v.toLowerCase() === valueLower)

  let newValues: string[]
  if (idx >= 0) {
    // Value present — remove it (toggle off)
    newValues = currentValues.filter((_, i) => i !== idx)
  } else {
    // Value absent — add it
    newValues = [...currentValues, value]
  }

  if (newValues.length === 0) {
    // Remove the entire token
    return query.replace(tokenRe, "").replace(/\s{2,}/g, " ").trim()
  }

  // If negation changed, rebuild with new prefix; otherwise keep existing
  const newNegated = idx >= 0 ? existingNegated : negated
  const newPrefix = newNegated ? "-" : ""
  const replacement = `${newPrefix}${qualLower}:${newValues.join(",")}`
  return query.replace(tokenRe, replacement).replace(/\s{2,}/g, " ").trim()
}

/**
 * Remove a qualifier entirely from the query string.
 */
export function removeToken(query: string, qualifier: string): string {
  const tokenRe = new RegExp(`-?${qualifier.toLowerCase()}:(?:"(?:[^"\\\\]|\\\\.)*"|[^\\s]*)`, "gi")
  return query.replace(tokenRe, "").replace(/\s{2,}/g, " ").trim()
}

/**
 * Check whether a specific value is active for a qualifier in the query string.
 * Used by the filter panel to determine button highlight state.
 */
export function isTokenActive(query: string, qualifier: string, value: string): boolean {
  const tokenRe = new RegExp(`(?:^|\\s)-?${qualifier.toLowerCase()}:("(?:[^"\\\\]|\\\\.)*"|[^\\s]*)`, "i")
  const match = tokenRe.exec(query)
  if (!match) return false
  const rawValues = match[1].startsWith('"') ? match[1].slice(1, -1) : match[1]
  return rawValues.split(",").some(v => v.trim().toLowerCase() === value.toLowerCase())
}
