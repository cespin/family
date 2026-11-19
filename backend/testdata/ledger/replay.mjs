// Reference model of the ledger replay described in docs/frontend-requirements.md, sections 5, 6
// and 12. It exists to compute the data set's expected results and is not production code. All
// arithmetic is exact, so a figure here never depends on floating point.

const DIGITS = { CAD: 2, USD: 2, CLP: 0 };

const gcd = (a, b) => {
  let [x, y] = [a < 0n ? -a : a, b < 0n ? -b : b];
  while (y) [x, y] = [y, x % y];
  return x;
};

export function frac(numerator, denominator = 1n) {
  let [n, d] = [BigInt(numerator), BigInt(denominator)];
  if (d < 0n) [n, d] = [-n, -d];
  const divisor = gcd(n, d) || 1n;
  return { n: n / divisor, d: d / divisor };
}

const add = (a, b) => frac(a.n * b.d + b.n * a.d, a.d * b.d);
const sub = (a, b) => add(a, frac(-b.n, b.d));
const mul = (a, b) => frac(a.n * b.n, a.d * b.d);
const div = (a, b) => frac(a.n * b.d, a.d * b.n);
const cmp = (a, b) => {
  const [left, right] = [a.n * b.d, b.n * a.d];
  if (left === right) return 0;
  return left < right ? -1 : 1;
};
const smallest = (...values) => values.reduce((low, value) => (cmp(value, low) < 0 ? value : low));
const isPositive = (a) => a.n > 0n;

/** Rounds to a whole number, with halves going away from zero so both sides of a debt mirror. */
export function round(a) {
  const sign = a.n < 0n ? -1n : 1n;
  const magnitude = a.n * sign;
  return Number(sign * ((2n * magnitude + a.d) / (2n * a.d)));
}

export function decimal(text) {
  const [whole, fraction = ''] = text.split('.');
  return frac(BigInt(whole + fraction), 10n ** BigInt(fraction.length));
}

function cadPer(currency, rates) {
  if (currency === 'CAD') return frac(1);
  return currency === 'USD' ? decimal(rates.usdCad) : div(frac(1), decimal(rates.cadClp));
}

/** Converts minor units exactly. Null when the rates needed are missing. */
export function convert(value, from, to, rates) {
  if (from === to) return value;
  if (!rates) return null;
  const major = div(value, frac(10n ** BigInt(DIGITS[from])));
  const cad = mul(major, cadPer(from, rates));
  return mul(div(cad, cadPer(to, rates)), frac(10n ** BigInt(DIGITS[to])));
}

/** Whether a credited value is within one minor unit of the paying currency. */
export function withinTolerance(paid, credited, rates) {
  const converted = convert(frac(paid.amountMinor), paid.currency, credited.currency, rates);
  const unit = convert(frac(1), paid.currency, credited.currency, rates);
  if (!converted || !unit) return false;
  const gap = sub(converted, frac(credited.amountMinor));
  const distance = gap.n < 0n ? frac(-gap.n, gap.d) : gap;
  return cmp(distance, unit) <= 0;
}

export function splitEqual(total, ids) {
  const each = Math.floor(total / ids.length);
  const remainder = total - each * ids.length;
  return Object.fromEntries(ids.map((id, index) => [id, each + (index < remainder ? 1 : 0)]));
}

export function splitPercent(total, ids, percents) {
  const shares = Object.fromEntries(
    ids.map((id) => [id, round(frac(BigInt(total) * BigInt(percents[id]), 100n))]),
  );
  const largest = ids.reduce((top, id) => (shares[id] > shares[top] ? id : top), ids[0]);
  const assigned = ids.reduce((sum, id) => sum + shares[id], 0);
  return { ...shares, [largest]: shares[largest] + total - assigned };
}

export const pairKey = (x, y) => (x < y ? `${x}|${y}` : `${y}|${x}`);

// Amounts inside a pair are signed from the point of view of `low`: positive means `high` owes.
function replayPair(low, high, events, { prune = false } = {}) {
  let debts = [];
  const credits = [];
  const allocations = [];
  let newest = null;

  const openIn = (groupId) => debts.filter((debt) => !debt.closed && debt.groupId === groupId);

  function groupNet(groupId, currency, rates) {
    let value = frac(0);
    let complete = true;
    for (const debt of openIn(groupId)) {
      const converted = convert(frac(debt.remaining), debt.currency, currency, rates);
      if (converted) value = add(value, converted);
      else complete = false;
    }
    return { value, complete };
  }

  function closeIfEven(groupId, currency, rates) {
    const { value, complete } = groupNet(groupId, currency, rates);
    if (complete && round(value) === 0) {
      openIn(groupId).forEach((debt) => {
        debt.closed = true;
      });
    }
  }

  // How much of a debt's group can still be paid, in `currency`, by the side owing `direction`.
  function room(groupId, direction, currency, rates) {
    const signed = mul(groupNet(groupId, currency, rates).value, frac(direction));
    return isPositive(signed) ? signed : frac(0);
  }

  function cover(debt, taken, owed, currency, rates, paymentId) {
    const size = Math.abs(debt.remaining);
    const covered =
      cmp(taken, owed) >= 0
        ? size
        : Math.min(size, round(convert(taken, currency, debt.currency, rates)));
    if (covered === 0) return false;
    debt.remaining -= Math.sign(debt.remaining) * covered;
    if (debt.remaining === 0) debt.closed = true;
    allocations.push({ paymentId, expenseId: debt.expenseId, applied: taken, coveredMinor: covered });
    return true;
  }

  function applyExpense(event) {
    const { id, groupId, date, seq, currency, payerId, shares, recordedRates: rates } = event;
    let gross = 0;
    if (payerId === low && shares[high]) gross = shares[high];
    if (payerId === high && shares[low]) gross = -shares[low];
    if (gross === 0) return;

    const debt = { expenseId: id, groupId, date, seq, currency, gross, remaining: gross, closed: false };
    debts.push(debt);
    if (!newest || date > newest.date || (date === newest.date && seq > newest.seq)) {
      newest = { date, seq, groupId };
    }

    // Credit held by the person who now owes this debt pays it straight away.
    const holderSign = -Math.sign(gross);
    const usable = credits
      .filter((credit) => Math.sign(credit.minor) === holderSign)
      .sort((a, b) => (b.groupId === groupId) - (a.groupId === groupId) || a.seq - b.seq);
    for (const credit of usable) {
      const available = convert(frac(Math.abs(credit.minor)), credit.currency, currency, rates);
      if (available && debt.remaining !== 0) {
        const owed = frac(Math.abs(debt.remaining));
        const limit = room(groupId, Math.sign(gross), currency, rates);
        const taken = smallest(available, owed, limit);
        if (isPositive(taken)) {
          const used =
            cmp(taken, available) >= 0
              ? Math.abs(credit.minor)
              : round(convert(taken, currency, credit.currency, rates));
          if (cover(debt, taken, owed, currency, rates, credit.paymentId)) {
            const allocation = allocations[allocations.length - 1];
            allocation.applied = frac(used);
            allocation.creditBefore = credit.applied;
            credit.applied = add(credit.applied, frac(used));
            credit.minor -= Math.sign(credit.minor) * used;
          }
        }
      }
    }
    closeIfEven(groupId, currency, rates);
  }

  function applyPayment(event) {
    const { id, seq, fromId, groupId: chosen, credited, recordedRates: rates } = event;
    const { amountMinor, currency } = credited;
    // The payer owes the debts whose sign this is.
    const direction = fromId === low ? -1 : 1;
    let left = frac(amountMinor);
    let allocated = frac(0);

    const owing = debts
      .filter((debt) => !debt.closed && Math.sign(debt.remaining) === direction)
      .sort((a, b) => a.date.localeCompare(b.date) || a.seq - b.seq);
    const ordered = chosen
      ? [...owing.filter((d) => d.groupId === chosen), ...owing.filter((d) => d.groupId !== chosen)]
      : owing;

    for (const debt of ordered) {
      const owed = convert(frac(Math.abs(debt.remaining)), debt.currency, currency, rates);
      if (!debt.closed && owed && isPositive(left)) {
        const taken = smallest(left, owed, room(debt.groupId, direction, currency, rates));
        if (isPositive(taken) && cover(debt, taken, owed, currency, rates, id)) {
          left = sub(left, taken);
          allocated = add(allocated, taken);
          closeIfEven(debt.groupId, currency, rates);
        }
      }
    }

    // What remains first repays credit the other person holds, then becomes the payer's credit.
    const owedBack = credits
      .filter((credit) => Math.sign(credit.minor) === direction)
      .sort((a, b) => a.seq - b.seq);
    for (const credit of owedBack) {
      const available = convert(frac(Math.abs(credit.minor)), credit.currency, currency, rates);
      if (available && isPositive(left)) {
        const taken = smallest(left, available);
        const used =
          cmp(taken, available) >= 0
            ? Math.abs(credit.minor)
            : round(convert(taken, currency, credit.currency, rates));
        credit.minor -= Math.sign(credit.minor) * used;
        left = sub(left, taken);
      }
    }

    const rest = round(left);
    if (rest > 0) {
      credits.push({
        paymentId: id,
        seq,
        minor: -direction * rest,
        currency,
        // Exactly how much of this payment has reached debts. The credit itself is rounded, so the
        // paid amount of a later slice cannot be worked out from it.
        applied: allocated,
        groupId: chosen ?? newest?.groupId ?? null,
      });
    }
  }

  for (const event of events) {
    if (event.type === 'expense') applyExpense(event);
    else applyPayment(event);
    // Stored pair state keeps only open debts, so the rules must never need a closed one.
    if (prune) debts = debts.filter((debt) => !debt.closed);
  }
  return { low, high, debts, credits, allocations, newest };
}

function concerns(event, low, high) {
  if (event.type === 'payment') {
    return [event.fromId, event.toId].sort().join('|') === `${low}|${high}`;
  }
  return (
    (event.payerId === low && event.shares[high] > 0) ||
    (event.payerId === high && event.shares[low] > 0)
  );
}

/** Replays every pair of members, in recording order. */
export function replay(memberIds, events, options) {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const ids = [...memberIds].sort();
  const pairs = new Map();
  ids.forEach((low, index) => {
    ids.slice(index + 1).forEach((high) => {
      const own = ordered.filter((event) => concerns(event, low, high));
      if (own.length > 0) pairs.set(pairKey(low, high), replayPair(low, high, own, options));
    });
  });
  return pairs;
}

const towards = (pair, me) => (pair.low === me ? 1 : -1);

/** The open amounts between `me` and each other member, in their original currencies. */
export function standingsFor(pairs, me) {
  const rows = [];
  for (const pair of pairs.values()) {
    if (pair.low === me || pair.high === me) {
      const sign = towards(pair, me);
      const totals = new Map();
      const addAmount = (groupId, currency, minor) => {
        const key = `${groupId ?? ''}|${currency}`;
        totals.set(key, { groupId, currency, minor: (totals.get(key)?.minor ?? 0) + minor });
      };
      pair.debts
        .filter((debt) => !debt.closed)
        .forEach((debt) => addAmount(debt.groupId, debt.currency, sign * debt.remaining));
      pair.credits
        .filter((credit) => credit.minor !== 0)
        .forEach((credit) => addAmount(credit.groupId, credit.currency, sign * credit.minor));

      const entries = [...totals.values()].filter((entry) => entry.minor !== 0);
      if (entries.length > 0) {
        rows.push({ memberId: pair.low === me ? pair.high : pair.low, entries });
      }
    }
  }
  return rows;
}

/** The debt on one expense between two members, or undefined when there is none. */
export function debtBetween(pairs, expenseId, x, y) {
  return pairs.get(pairKey(x, y))?.debts.find((debt) => debt.expenseId === expenseId);
}

/** What one expense means for `me`, and how far each participant has paid. */
export function expenseView(pairs, expense, me) {
  const { id, payerId, participantIds } = expense;
  const others = participantIds.filter((memberId) => memberId !== payerId);
  const involved = payerId === me || participantIds.includes(me);

  // A share that rounds to zero creates no debt, so there is nothing left to pay on it.
  let standing = { involved: false, openMinor: null, settled: false };
  if (payerId === me) {
    const mine = others.map((memberId) => debtBetween(pairs, id, me, memberId)).filter(Boolean);
    const openMinor = mine
      .filter((debt) => !debt.closed)
      .reduce((sum, debt) => sum + Math.abs(debt.remaining), 0);
    standing = { involved, openMinor, settled: others.length > 0 && mine.every((d) => d.closed) };
  } else if (involved) {
    const debt = debtBetween(pairs, id, me, payerId);
    const closed = !debt || debt.closed;
    standing = {
      involved,
      openMinor: closed ? 0 : -Math.abs(debt.remaining),
      settled: closed,
    };
  }

  const participants = participantIds.map((memberId) => {
    if (memberId === payerId) return { memberId, status: 'paid' };
    const debt = debtBetween(pairs, id, memberId, payerId);
    if (!debt || debt.closed) return { memberId, status: 'paid' };
    const partly = Math.abs(debt.remaining) < Math.abs(debt.gross);
    return { memberId, status: partly ? 'partly_paid' : 'owes' };
  });
  return { standing, participants };
}

/** What a pair owes per group and currency, signed from the point of view of `low`. */
export function pairBalances(pair) {
  const totals = new Map();
  const addAmount = (groupId, currency, minor) => {
    const key = `${groupId ?? ''}|${currency}`;
    totals.set(key, { groupId: groupId ?? undefined, currency, amountMinor: (totals.get(key)?.amountMinor ?? 0) + minor });
  };
  pair.debts
    .filter((debt) => !debt.closed)
    .forEach((debt) => addAmount(debt.groupId, debt.currency, debt.remaining));
  pair.credits.forEach((credit) => addAmount(credit.groupId, credit.currency, credit.minor));
  return [...totals.values()].filter((entry) => entry.amountMinor !== 0);
}

// Rounding the running total means the slices of a payment add up to what was paid.
const paidShare = (payment, value) =>
  round(mul(frac(payment.paid.amountMinor), div(value, frac(payment.credited.amountMinor))));

/** The paid amount of a slice funded by stored credit, from the credit's exact running total. */
export function creditSlicePaid(payment, appliedBefore, used) {
  return paidShare(payment, add(appliedBefore, used)) - paidShare(payment, appliedBefore);
}

/** Each slice of a pair's payments, with its share of what was really paid. */
export function allocationSlices(pair, payments) {
  const applied = new Map();
  return pair.allocations.map((allocation) => {
    const payment = payments.find((item) => item.id === allocation.paymentId);
    const before = applied.get(payment.id) ?? frac(0);
    const after = add(before, allocation.applied);
    applied.set(payment.id, after);
    return {
      expenseId: allocation.expenseId,
      paymentId: payment.id,
      fromId: payment.fromId,
      toId: payment.toId,
      paidMinor: paidShare(payment, after) - paidShare(payment, before),
      paidCurrency: payment.paid.currency,
      coveredMinor: allocation.coveredMinor,
      method: payment.method,
      date: payment.date,
    };
  });
}

/** Every slice of every payment applied to one expense. */
export function appliedPayments(pairs, payments, expenseId) {
  return [...pairs.values()]
    .flatMap((pair) => allocationSlices(pair, payments))
    .filter((slice) => slice.expenseId === expenseId);
}

/** Sums signed amounts in `to`, rounding once at the end. */
export function sumIn(entries, to, rates) {
  const total = entries.reduce(
    (sum, entry) => add(sum, convert(frac(entry.minor), entry.currency, to, rates)),
    frac(0),
  );
  return round(total);
}
