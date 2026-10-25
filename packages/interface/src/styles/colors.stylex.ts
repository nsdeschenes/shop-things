import * as stylex from '@stylexjs/stylex';

import {darkPalette, lightPalette} from './palette.stylex';

export const colors = stylex.defineVars({
  pageBackground: {
    default: lightPalette.pageBackground,
    '@media (prefers-color-scheme: dark)': darkPalette.pageBackground,
  },
  surface: {
    default: lightPalette.surface,
    '@media (prefers-color-scheme: dark)': darkPalette.surface,
  },
  surfaceHover: {
    default: lightPalette.surfaceHover,
    '@media (prefers-color-scheme: dark)': darkPalette.surfaceHover,
  },
  headerBackground: {
    default: lightPalette.headerBackground,
    '@media (prefers-color-scheme: dark)': darkPalette.headerBackground,
  },
  text: {
    default: lightPalette.text,
    '@media (prefers-color-scheme: dark)': darkPalette.text,
  },
  textMuted: {
    default: lightPalette.textMuted,
    '@media (prefers-color-scheme: dark)': darkPalette.textMuted,
  },
  errorText: {
    default: lightPalette.errorText,
    '@media (prefers-color-scheme: dark)': darkPalette.errorText,
  },
  warningText: {
    default: lightPalette.warningText,
    '@media (prefers-color-scheme: dark)': darkPalette.warningText,
  },
  noticeText: {
    default: lightPalette.noticeText,
    '@media (prefers-color-scheme: dark)': darkPalette.noticeText,
  },
  placeholder: {
    default: lightPalette.placeholder,
    '@media (prefers-color-scheme: dark)': darkPalette.placeholder,
  },
  onPrimary: {
    default: lightPalette.onPrimary,
    '@media (prefers-color-scheme: dark)': darkPalette.onPrimary,
  },
  onHeader: {
    default: lightPalette.onHeader,
    '@media (prefers-color-scheme: dark)': darkPalette.onHeader,
  },
  secondaryText: {
    default: lightPalette.secondaryText,
    '@media (prefers-color-scheme: dark)': darkPalette.secondaryText,
  },
  primary: {
    default: lightPalette.primary,
    '@media (prefers-color-scheme: dark)': darkPalette.primary,
  },
  primaryHover: {
    default: lightPalette.primaryHover,
    '@media (prefers-color-scheme: dark)': darkPalette.primaryHover,
  },
  danger: {
    default: lightPalette.danger,
    '@media (prefers-color-scheme: dark)': darkPalette.danger,
  },
  dangerHover: {
    default: lightPalette.dangerHover,
    '@media (prefers-color-scheme: dark)': darkPalette.dangerHover,
  },
  focusRing: {
    default: lightPalette.focusRing,
    '@media (prefers-color-scheme: dark)': darkPalette.focusRing,
  },
  border: {
    default: lightPalette.border,
    '@media (prefers-color-scheme: dark)': darkPalette.border,
  },
  controlBorder: {
    default: lightPalette.controlBorder,
    '@media (prefers-color-scheme: dark)': darkPalette.controlBorder,
  },
  checkboxBorder: {
    default: lightPalette.checkboxBorder,
    '@media (prefers-color-scheme: dark)': darkPalette.checkboxBorder,
  },
  disabledBackground: {
    default: lightPalette.disabledBackground,
    '@media (prefers-color-scheme: dark)': darkPalette.disabledBackground,
  },
  tableHeaderBackground: {
    default: lightPalette.tableHeaderBackground,
    '@media (prefers-color-scheme: dark)': darkPalette.tableHeaderBackground,
  },
  rowHover: {
    default: lightPalette.rowHover,
    '@media (prefers-color-scheme: dark)': darkPalette.rowHover,
  },
  successBackground: {
    default: lightPalette.successBackground,
    '@media (prefers-color-scheme: dark)': darkPalette.successBackground,
  },
  successText: {
    default: lightPalette.successText,
    '@media (prefers-color-scheme: dark)': darkPalette.successText,
  },
  successBorder: {
    default: lightPalette.successBorder,
    '@media (prefers-color-scheme: dark)': darkPalette.successBorder,
  },
  warningBackground: {
    default: lightPalette.warningBackground,
    '@media (prefers-color-scheme: dark)': darkPalette.warningBackground,
  },
  warningHoverBackground: {
    default: lightPalette.warningHoverBackground,
    '@media (prefers-color-scheme: dark)': darkPalette.warningHoverBackground,
  },
  toastText: {
    default: lightPalette.toastText,
    '@media (prefers-color-scheme: dark)': darkPalette.toastText,
  },
  toastSuccessBackground: {
    default: lightPalette.toastSuccessBackground,
    '@media (prefers-color-scheme: dark)': darkPalette.toastSuccessBackground,
  },
  toastErrorBackground: {
    default: lightPalette.toastErrorBackground,
    '@media (prefers-color-scheme: dark)': darkPalette.toastErrorBackground,
  },
  toastWarningBackground: {
    default: lightPalette.toastWarningBackground,
    '@media (prefers-color-scheme: dark)': darkPalette.toastWarningBackground,
  },
  toastNoticeBackground: {
    default: lightPalette.toastNoticeBackground,
    '@media (prefers-color-scheme: dark)': darkPalette.toastNoticeBackground,
  },
  backdrop: {
    default: lightPalette.backdrop,
    '@media (prefers-color-scheme: dark)': darkPalette.backdrop,
  },
});
