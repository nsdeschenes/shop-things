// Debian Policy 5.6.12: epoch, then alternating non-digit/digit parts of
// upstream version and revision. Discovery does not require dpkg to be installed.
const digit = /^[0-9]$/;
const letter = /^[A-Za-z]$/;

export async function compareDebianVersions(
  left: string,
  right: string
): Promise<number> {
  function parts(value: string) {
    const colon = value.indexOf(':');
    const epoch = colon >= 0 ? BigInt(value.slice(0, colon)) : 0n;
    const rest = colon >= 0 ? value.slice(colon + 1) : value;
    const hyphen = rest.lastIndexOf('-');
    return {
      epoch,
      upstream: hyphen >= 0 ? rest.slice(0, hyphen) : rest,
      revision: hyphen >= 0 ? rest.slice(hyphen + 1) : '0',
    };
  }

  const a = parts(left);
  const b = parts(right);
  if (a.epoch !== b.epoch) {
    return a.epoch > b.epoch ? 1 : -1;
  }

  return comparePart(a.upstream, b.upstream) || comparePart(a.revision, b.revision);
}

function order(char: string | undefined): number {
  if (char === '~') {
    return -1;
  }

  if (!char || digit.test(char)) {
    return 0;
  }

  return char.charCodeAt(0) + (letter.test(char) ? 0 : 256);
}

function comparePart(left: string, right: string): number {
  let a = 0;
  let b = 0;
  while (a < left.length || b < right.length) {
    while (
      (a < left.length && !digit.test(left[a]!)) ||
      (b < right.length && !digit.test(right[b]!))
    ) {
      const difference = order(left[a]) - order(right[b]);
      if (difference) {
        return difference > 0 ? 1 : -1;
      }

      if (a < left.length) {
        a++;
      }

      if (b < right.length) {
        b++;
      }
    }

    while (left[a] === '0') {
      a++;
    }

    while (right[b] === '0') {
      b++;
    }

    const aStart = a;
    const bStart = b;
    while (a < left.length && digit.test(left[a]!)) {
      a++;
    }

    while (b < right.length && digit.test(right[b]!)) {
      b++;
    }

    if (a - aStart !== b - bStart) {
      return a - aStart > b - bStart ? 1 : -1;
    }

    const aDigits = left.slice(aStart, a);
    const bDigits = right.slice(bStart, b);
    if (aDigits !== bDigits) {
      return aDigits > bDigits ? 1 : -1;
    }
  }

  return 0;
}
