import {Button as BaseButton} from '@base-ui/react/button';
import * as stylex from '@stylexjs/stylex';

import buttonStyles from './buttonStyles';

type Props = Omit<BaseButton.Props, 'className' | 'style'> & {
  variant?: 'primary' | 'secondary' | 'danger';
  busy?: boolean;
};

export default function Button({variant = 'secondary', busy = false, ...props}: Props) {
  return (
    <BaseButton
      {...props}
      disabled={busy || props.disabled}
      aria-busy={busy || undefined}
      {...stylex.props(
        buttonStyles.base,
        variant === 'primary' && buttonStyles.primary,
        variant === 'danger' && buttonStyles.danger
      )}
    />
  );
}
