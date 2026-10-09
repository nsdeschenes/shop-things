const {resolve} = require('node:path');

// Validate trust at the packaging entry too, including direct builder invocations.
module.exports = async context => {
  const {prepareUpdateIdentity} =
    await import('../../../scripts/prepareUpdateIdentity.ts');
  await prepareUpdateIdentity(resolve(context.packager.projectDir, '../..'));
};
