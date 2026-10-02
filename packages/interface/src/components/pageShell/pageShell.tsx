import * as stylex from '@stylexjs/stylex';
import type {ReactNode} from 'react';

import {breakpoints} from '../../styles/breakpoints.stylex';
import {colors} from '../../styles/colors.stylex';
import {spacing} from '../../styles/spacing.stylex';
import {typography} from '../../styles/typography.stylex';

type Props = {
  title: string;
  actions?: ReactNode;
  notice?: ReactNode;
  stickyHeader?: boolean;
  children: ReactNode;
};

const styles = stylex.create({
  page: {
    marginInline: 'auto',
    paddingInline: {default: spacing.space24, [breakpoints.compact]: spacing.space16},
    maxWidth: 1240,
    paddingBottom: spacing.space24,
    paddingTop: spacing.space22,
  },
  header: {
    gap: spacing.space12,
    paddingBlock: spacing.space4,
    alignItems: 'center',
    backgroundColor: colors.pageBackground,
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    marginBottom: spacing.space18,
  },
  sticky: {position: 'sticky', zIndex: 1, top: 0},
  title: {fontSize: 30, fontWeight: typography.fontWeightSemibold, letterSpacing: -0.6},
});

export default function PageShell({
  title,
  actions,
  notice,
  stickyHeader = false,
  children,
}: Props) {
  return (
    <main {...stylex.props(styles.page)}>
      {notice}
      <header {...stylex.props(styles.header, stickyHeader && styles.sticky)}>
        <h1 {...stylex.props(styles.title)}>{title}</h1>
        {actions}
      </header>
      {children}
    </main>
  );
}
