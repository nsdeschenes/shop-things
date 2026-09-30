import * as stylex from '@stylexjs/stylex';
import type {ComponentProps} from 'react';

import {colors} from '../../styles/colors.stylex';
import {controls} from '../../styles/controls.stylex';
import {spacing} from '../../styles/spacing.stylex';
import {typography} from '../../styles/typography.stylex';

type Props<Tag extends 'div' | 'table' | 'thead' | 'tbody' | 'tr' | 'th' | 'td'> = Omit<
  ComponentProps<Tag>,
  'className' | 'style' | 'align'
>;
type Alignment = 'left' | 'center' | 'right';

const styles = stylex.create({
  container: {overflowX: 'auto'},
  table: {
    backgroundColor: colors.surface,
    borderCollapse: 'collapse',
    minWidth: 640,
    width: '100%',
  },
  head: {
    backgroundColor: colors.tableHeaderBackground,
    fontSize: typography.fontSizeSmall,
    textAlign: 'left',
  },
  cell: {
    paddingBlock: spacing.space14,
    paddingInline: spacing.space18,
    borderBottomColor: colors.border,
    borderBottomStyle: 'solid',
    borderBottomWidth: controls.borderWidth,
  },
  interactiveRow: {
    backgroundColor: {
      default: colors.surface,
      ':focus-within': colors.rowHover,
      ':hover': colors.rowHover,
    },
    cursor: 'pointer',
  },
  left: {textAlign: 'left'},
  center: {textAlign: 'center'},
  right: {textAlign: 'right'},
});

function TableRoot(props: Props<'table'>) {
  return <table {...props} {...stylex.props(styles.table)} />;
}

function Container(props: Props<'div'>) {
  return <div {...props} {...stylex.props(styles.container)} />;
}

function Head(props: Props<'thead'>) {
  return <thead {...props} {...stylex.props(styles.head)} />;
}

function Body(props: Props<'tbody'>) {
  return <tbody {...props} />;
}

function Row({onClick, ...props}: Props<'tr'>) {
  return (
    <tr
      {...props}
      onClick={onClick}
      {...stylex.props(onClick && styles.interactiveRow)}
    />
  );
}

function HeaderCell({
  align = 'left',
  scope = 'col',
  ...props
}: Props<'th'> & {align?: Alignment}) {
  return <th {...props} scope={scope} {...stylex.props(styles.cell, styles[align])} />;
}

function Cell({align = 'left', ...props}: Props<'td'> & {align?: Alignment}) {
  return <td {...props} {...stylex.props(styles.cell, styles[align])} />;
}

const Table = Object.assign(TableRoot, {Container, Head, Body, Row, HeaderCell, Cell});

export default Table;
