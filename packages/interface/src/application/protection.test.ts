import {expect, test} from 'vitest';

import createPreviewClient from './preview';
import {createDraftProtection, sameDraftValues} from './protection';

function fixture() {
  const client = createPreviewClient();
  let values = {name: 'Alex', balance: '0.00', donate: false};
  const baseline = {...values};
  let resets = 0;
  const owner = createDraftProtection(() => client);
  owner.registerEditor({
    values: () => values,
    baseline: () => baseline,
    reset() {
      resets++;
      values = {...baseline};
    },
  });
  return {
    client,
    owner,
    baseline,
    resets: () => resets,
    values: () => values,
    edit(next: Partial<typeof values>) {
      values = {...values, ...next};
      owner.changed();
    },
  };
}

const request = {requestId: 'one', documentId: 'document'};

test('exact invalid editable values are dirty and restoring all baseline values makes clean', () => {
  const f = fixture();
  expect(f.owner.isDirty()).toBe(false);
  f.edit({balance: '-'});
  expect(f.owner.isDirty()).toBe(true);
  f.edit({balance: '0.00', donate: true});
  expect(f.owner.isDirty()).toBe(true);
  f.edit({donate: false});
  expect(f.owner.isDirty()).toBe(false);
  expect(sameDraftValues({name: 'Alex'}, {name: 'Alex', other: ''})).toBe(false);
});

test('matching-only lifecycle resolution preserves aborted drafts and ignores stale or duplicate messages', async () => {
  const f = fixture();
  f.edit({balance: 'invalid'});
  expect(await f.owner.prepare(request)).toEqual({...request, hasUnsavedDraft: true});
  expect(f.owner.getState().frozen).toBe(true);
  expect(f.owner.resolve({...request, requestId: 'other', outcome: 'committed'})).toBe(
    false
  );
  expect(f.owner.resolve({...request, documentId: 'other', outcome: 'committed'})).toBe(
    false
  );
  expect(f.resets()).toBe(0);
  expect(f.owner.resolve({...request, outcome: 'aborted'})).toBe(true);
  expect(f.values().balance).toBe('invalid');
  expect(f.owner.getState().frozen).toBe(false);
  expect(f.owner.resolve({...request, outcome: 'committed'})).toBe(false);
  await f.owner.prepare({...request, requestId: 'two'});
  f.owner.resolve({...request, requestId: 'two', outcome: 'committed'});
  expect(f.resets()).toBe(1);
  expect(f.owner.isDirty()).toBe(false);
});

test('lifecycle freezes before awaiting already pending complete save and inspects resulting draft', async () => {
  const f = fixture();
  f.edit({name: 'Submitted'});
  let finish!: () => void;
  const wait = new Promise<void>(done => {
    finish = done;
  });
  const saving = f.owner.save(async () => {
    await wait;
    Object.assign(f.baseline, {name: 'Submitted'});
  });
  f.edit({name: 'Newer edit'});
  const preparing = f.owner.prepare(request);
  expect(f.owner.getState()).toMatchObject({frozen: true, saving: true});
  await expect(f.owner.save(async () => {})).rejects.toThrow('Wait');
  expect(await f.owner.blockNavigation('/customers')).toBe(true);
  finish();
  await saving;
  expect(await preparing).toEqual({...request, hasUnsavedDraft: true});
  expect(
    f.owner.navigateAfterSave(() => {
      throw new Error('Must not navigate');
    })
  ).toBe(false);
  f.owner.resolve({...request, outcome: 'aborted'});
  expect(f.values().name).toBe('Newer edit');
});

test('failed save and aborted preparation retain values while an explicitly clean participant is valid', async () => {
  const f = fixture();
  f.edit({balance: '-'});
  await expect(
    f.owner.save(async () => {
      throw new Error('Failed save');
    })
  ).rejects.toThrow('Failed save');
  expect(f.values().balance).toBe('-');
  await f.owner.prepare(request);
  f.owner.dispose();
  expect(f.owner.getState().frozen).toBe(false);
  expect(f.values().balance).toBe('-');
  expect(f.owner.resolve({...request, outcome: 'committed'})).toBe(false);
  const clean = createDraftProtection(() => f.client);
  expect(await clean.prepare(request)).toEqual({...request, hasUnsavedDraft: false});
});

test('route discard approval freezes and clears only after matching committed navigation', async () => {
  const f = fixture();
  f.edit({balance: 'incomplete'});
  f.client.drafts.confirmDiscard = async () => ({
    status: 'success',
    value: {approved: true},
  });
  expect(await f.owner.blockNavigation('/customers')).toBe(false);
  expect(f.owner.getState().frozen).toBe(true);
  expect(f.values().balance).toBe('incomplete');
  expect(await f.owner.blockNavigation('/customers/new')).toBe(true);
  await expect(f.owner.prepare(request)).rejects.toThrow('Another');
  f.owner.navigationResolved('/other');
  expect(f.resets()).toBe(0);
  f.owner.navigationResolved('/customers');
  expect(f.resets()).toBe(1);
  expect(f.owner.getState().frozen).toBe(false);
});

test('Stay, failed confirmation and failed approved navigation preserve exact drafts', async () => {
  const f = fixture();
  f.edit({name: ''});
  f.client.drafts.confirmDiscard = async () => ({status: 'cancelled'});
  expect(await f.owner.blockNavigation('/customers')).toBe(true);
  expect(f.owner.getState().frozen).toBe(false);
  f.client.drafts.confirmDiscard = async () => {
    throw new Error('Dialog failed');
  };

  expect(await f.owner.blockNavigation('/customers')).toBe(true);
  f.client.drafts.confirmDiscard = async () => ({
    status: 'success',
    value: {approved: true},
  });
  expect(await f.owner.blockNavigation('/customers')).toBe(false);
  f.owner.navigationResolved('/customers', false);
  expect(f.values().name).toBe('');
  expect(f.resets()).toBe(0);
  expect(f.owner.getState().frozen).toBe(false);
});

test('aborting preparation while Save waits cannot publish a late reply or reset newer editor', async () => {
  const f = fixture();
  let finish!: () => void;
  const saving = f.owner.save(
    () =>
      new Promise<void>(done => {
        finish = done;
      })
  );
  await Promise.resolve();
  const preparing = f.owner.prepare(request);
  f.owner.resolve({...request, outcome: 'aborted'});
  finish();
  await saving;
  await expect(preparing).rejects.toThrow('aborted');
  expect(f.resets()).toBe(0);
});
