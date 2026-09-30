import {useEffect, useSyncExternalStore} from 'react';

import type {Application} from './controller';
import type {DraftEditor} from './protection';

// Supply a stable editor object. Its readers return the current exact editable values.
export default function useDraftProtection(
  application: Application,
  editor: DraftEditor
) {
  useEffect(() => application.protection.registerEditor(editor), [application, editor]);
  return useSyncExternalStore(
    application.protection.subscribe,
    application.protection.getState
  );
}
