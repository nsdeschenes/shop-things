// Parent configuration evaluates before targets create their temporary scripts.
// Tighten only this Linux builder process, preserving any stricter caller mask.
if (process.platform === 'linux') {
  process.umask(process.umask() | 0o022);
}

module.exports = {};
