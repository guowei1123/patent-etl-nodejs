/**
 * Format bytes to human-readable string (e.g., "12.5 MB")
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/**
 * Format speed in bytes/sec to human-readable string (e.g., "2.0 MB/s")
 */
export function formatSpeed(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`
}

/**
 * Format seconds to human-readable duration (e.g., "2m 30s", "1h 15m")
 * Returns null if input is null or negative.
 */
export function formatDuration(seconds: number | null): string | null {
  if (seconds === null || seconds < 0) return null
  if (seconds < 1) return '< 1s'
  if (seconds < 60) return `${Math.round(seconds)}s`
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60)
    const s = Math.round(seconds % 60)
    return s > 0 ? `${m}m ${s}s` : `${m}m`
  }
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

/**
 * Format a progress ratio as "downloaded / total (percent%)"
 * Example: "50.0 MB / 100.0 MB (50%)"
 */
export function formatProgress(downloaded: number, total: number): string {
  if (total <= 0) return formatBytes(downloaded)
  const percent = Math.min(Math.round((downloaded / total) * 100), 100)
  return `${formatBytes(downloaded)} / ${formatBytes(total)} (${percent}%)`
}
