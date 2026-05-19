'use client'

import * as React from 'react'

type Theme = 'light' | 'dark' | 'system'
type ResolvedTheme = 'light' | 'dark'

type ThemeProviderProps = React.PropsWithChildren<{
  attribute?: 'class' | `data-${string}`
  defaultTheme?: Theme
  enableSystem?: boolean
  disableTransitionOnChange?: boolean
}>

type ThemeContextValue = {
  theme: Theme
  setTheme: React.Dispatch<React.SetStateAction<string>>
  resolvedTheme: ResolvedTheme
  systemTheme: ResolvedTheme
  themes: Theme[]
}

const STORAGE_KEY = 'theme'
const THEME_QUERY = '(prefers-color-scheme: dark)'

const ThemeContext = React.createContext<ThemeContextValue | null>(null)

function getSystemTheme(): ResolvedTheme {
  return window.matchMedia(THEME_QUERY).matches ? 'dark' : 'light'
}

function applyTheme(
  theme: Theme,
  attribute: NonNullable<ThemeProviderProps['attribute']>,
  enableSystem: boolean,
) {
  const resolvedTheme =
    theme === 'system' && enableSystem ? getSystemTheme() : theme
  const className = resolvedTheme === 'dark' ? 'dark' : 'light'
  const root = document.documentElement

  if (attribute === 'class') {
    root.classList.remove('light', 'dark')
    root.classList.add(className)
  } else {
    root.setAttribute(attribute, className)
  }

  root.style.colorScheme = className
  return className
}

function getStoredTheme(defaultTheme: Theme) {
  if (typeof window === 'undefined') return defaultTheme

  const storedTheme = window.localStorage.getItem(STORAGE_KEY)
  return storedTheme === 'light' ||
    storedTheme === 'dark' ||
    storedTheme === 'system'
    ? storedTheme
    : defaultTheme
}

function disableTransitions() {
  const style = document.createElement('style')
  style.appendChild(
    document.createTextNode(
      '*,*::before,*::after{transition:none!important}',
    ),
  )
  document.head.appendChild(style)

  return () => {
    window.getComputedStyle(document.body)
    window.setTimeout(() => document.head.removeChild(style), 1)
  }
}

export function ThemeProvider({
  children,
  attribute = 'class',
  defaultTheme = 'system',
  enableSystem = true,
  disableTransitionOnChange = false,
}: ThemeProviderProps) {
  const [theme, setThemeState] = React.useState<Theme>(() =>
    getStoredTheme(defaultTheme),
  )
  const [systemTheme, setSystemTheme] = React.useState<ResolvedTheme>(() =>
    typeof window === 'undefined' ? 'light' : getSystemTheme(),
  )

  React.useEffect(() => {
    applyTheme(theme, attribute, enableSystem)
  }, [attribute, enableSystem, theme])

  React.useEffect(() => {
    const mediaQuery = window.matchMedia(THEME_QUERY)
    const handleChange = () => {
      const nextSystemTheme = getSystemTheme()
      setSystemTheme(nextSystemTheme)
      if (theme === 'system' && enableSystem) {
        applyTheme('system', attribute, enableSystem)
      }
    }

    mediaQuery.addEventListener('change', handleChange)
    return () => mediaQuery.removeEventListener('change', handleChange)
  }, [attribute, enableSystem, theme])

  const setTheme = React.useCallback<ThemeContextValue['setTheme']>(
    (value) => {
      const nextTheme = typeof value === 'function' ? value(theme) : value
      if (!['light', 'dark', 'system'].includes(nextTheme)) return

      const enableTransitions = disableTransitionOnChange
        ? disableTransitions()
        : undefined

      const typedTheme = nextTheme as Theme
      window.localStorage.setItem(STORAGE_KEY, typedTheme)
      setThemeState(typedTheme)
      setSystemTheme(getSystemTheme())
      applyTheme(typedTheme, attribute, enableSystem)
      enableTransitions?.()
    },
    [attribute, disableTransitionOnChange, enableSystem, theme],
  )

  const resolvedTheme =
    theme === 'system' && enableSystem ? systemTheme : (theme as ResolvedTheme)

  const value = React.useMemo<ThemeContextValue>(
    () => ({
      theme,
      setTheme,
      resolvedTheme,
      systemTheme,
      themes: ['light', 'dark', 'system'],
    }),
    [resolvedTheme, setTheme, systemTheme, theme],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const context = React.useContext(ThemeContext)
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider.')
  }

  return context
}
