import type { WorkbookSectionChangeType } from '@/types';
import { cssAlpha, cssVar } from '@/theme/cssUtils';
import type { ThemeTokens } from '@/theme/tokens';

export type DiffIndicatorTone = 'neutral' | 'add' | 'delete' | 'modify';
export type DiffIndicatorThemeTone = DiffIndicatorTone | 'strict-only';

export interface DiffIndicatorCssPalette {
  accent: string;
  text: string;
  border: string;
  background: string;
  softBackground: string;
  shadow: string;
}

export interface DiffIndicatorThemeVisual {
  background: string;
  border: string;
  textColor: string;
}

export function resolveDiffIndicatorCssPalette(
  tone: DiffIndicatorTone,
): DiffIndicatorCssPalette {
  if (tone === 'add') {
    return {
      accent: cssVar('addBrd'),
      text: cssVar('addTx'),
      border: cssAlpha('addBrd', '66'),
      background: cssVar('addBg'),
      softBackground: cssAlpha('addBrd', '14'),
      shadow: cssAlpha('addBrd', '55'),
    };
  }

  if (tone === 'delete') {
    return {
      accent: cssVar('delBrd'),
      text: cssVar('delTx'),
      border: cssAlpha('delBrd', '66'),
      background: cssVar('delBg'),
      softBackground: cssAlpha('delBrd', '14'),
      shadow: cssAlpha('delBrd', '55'),
    };
  }

  if (tone === 'modify') {
    return {
      accent: cssVar('chgBrd'),
      text: cssVar('chgTx'),
      border: cssAlpha('chgBrd', '66'),
      background: cssVar('chgBg'),
      softBackground: cssAlpha('chgBrd', '14'),
      shadow: cssAlpha('chgBrd', '55'),
    };
  }

  return {
    accent: cssVar('acc2'),
    text: cssVar('acc2'),
    border: cssAlpha('acc2', '66'),
    background: cssAlpha('acc2', '16'),
    softBackground: cssAlpha('acc2', '14'),
    shadow: cssAlpha('acc2', '55'),
  };
}

export function resolveDiffIndicatorThemeVisual(
  theme: ThemeTokens,
  tone: DiffIndicatorThemeTone,
  variant: 'soft' | 'strong' = 'soft',
): DiffIndicatorThemeVisual {
  if (tone === 'strict-only') {
    return variant === 'strong'
      ? {
          background: theme.whitespaceBg,
          border: theme.whitespaceBrd,
          textColor: theme.whitespaceTx,
        }
      : {
          background: `${theme.whitespaceBrd}14`,
          border: `${theme.whitespaceBrd}66`,
          textColor: theme.whitespaceTx,
        };
  }

  if (tone === 'add') {
    return variant === 'strong'
      ? {
          background: theme.addBg,
          border: theme.addBrd,
          textColor: theme.addTx,
        }
      : {
          background: `${theme.addBrd}12`,
          border: `${theme.addBrd}33`,
          textColor: theme.addTx,
        };
  }

  if (tone === 'delete') {
    return variant === 'strong'
      ? {
          background: theme.delBg,
          border: theme.delBrd,
          textColor: theme.delTx,
        }
      : {
          background: `${theme.delBrd}12`,
          border: `${theme.delBrd}33`,
          textColor: theme.delTx,
        };
  }

  if (tone === 'modify') {
    return variant === 'strong'
      ? {
          background: theme.chgBg,
          border: theme.chgBrd,
          textColor: theme.chgTx,
        }
      : {
          background: `${theme.chgBrd}12`,
          border: `${theme.chgBrd}33`,
          textColor: theme.chgTx,
        };
  }

  return {
    background: `${theme.acc2}12`,
    border: `${theme.acc2}44`,
    textColor: theme.acc2,
  };
}

export function resolveWorkbookSectionIndicatorTone(
  changeType: WorkbookSectionChangeType,
): DiffIndicatorTone {
  if (changeType === 'add') return 'add';
  if (changeType === 'delete') return 'delete';
  if (changeType === 'rename') return 'modify';
  return 'neutral';
}
