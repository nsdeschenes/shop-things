// Test-only controlled editor. The production protection owner and named client run
// in an actual renderer; customer forms remain disabled in the shipped application.
import {getClient} from '../packages/contract/dist/client.js';
import {createDraftProtection} from '../packages/interface/src/application/protection';

const client = getClient();
const owner = createDraftProtection(() => client);
const baseline = {balance: '0.00', name: 'Alex'};
let values = {...baseline};
const input = document.createElement('input');
input.setAttribute('aria-label', 'Controlled balance');
input.value = values.balance;
input.oninput = () => {
  values = {...values, balance: input.value};
  owner.changed();
};

document.body.append(input);
owner.subscribe(() => {
  input.disabled = owner.getState().frozen;
});
owner.registerEditor({
  values: () => values,
  baseline: () => baseline,
  reset() {
    values = {...baseline};
    input.value = values.balance;
  },
});
let finishSave: (() => void) | null = null;
let stop = client.drafts.registerProtection(owner);
Reflect.set(window, 'acceptanceEditor', {
  state: owner.getState,
  beginSave() {
    void owner.save(
      () =>
        new Promise<void>(resolve => {
          finishSave = resolve;
        })
    );
  },
  finishSave() {
    finishSave?.();
  },
  values: () => values,
  stop() {
    stop();
  },
  async restore() {
    values = {...baseline};
    input.value = values.balance;
    owner.changed();
    stop = client.drafts.registerProtection(owner);
    await client.database.status();
  },
});
await client.database.status();
Reflect.set(window, 'acceptanceEditorReady', true);
