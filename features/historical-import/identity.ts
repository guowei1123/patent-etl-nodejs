// CNIPA FTP omits the application checksum; Excel exports can include it.
export function applicationKey(value: string) {
  const normalized = value
    .toUpperCase()
    .replace(/^(CN|ZL)/, '')
    .replace(/[.\s]/g, '')
  if (/^(?:\d{8}|\d{12})$/.test(normalized)) return normalized
  if (/^(?:\d{8}|\d{12})[\dX]$/.test(normalized)) return normalized.slice(0, -1)
  throw new Error('申请号格式无效')
}
const normalizedSql =
  "regexp_replace(regexp_replace(upper(app_number), '^(CN|ZL)', ''), '[.[:space:]]', '', 'g')"
export const applicationSql = `CASE WHEN length(${normalizedSql}) IN (9,13)
  THEN left(${normalizedSql},length(${normalizedSql})-1) ELSE ${normalizedSql} END`
