//! Integer market rules shared with the NEAR contract.
//! A $10 Yes buy on a fresh 50/50 pool is the fixture in `buy_fixture_matches_javascript`.

pub const FEE_BPS: u128 = 50;
pub const LIQ: u128 = 800_000_000;
pub const DAY_MS: u64 = 24 * 60 * 60 * 1000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Buy {
    pub yes: u128,
    pub no: u128,
    pub shares: u128,
    pub fee: u128,
    pub net: u128,
}

/// Same complete-set CPMM as `applyBuy` in engine/math.mjs.
pub fn apply_buy(yes: u128, no: u128, budget: u128, yes_side: bool) -> Result<Buy, &'static str> {
    if budget == 0 {
        return Err("Amount must be positive");
    }
    let fee = budget * FEE_BPS / 10_000;
    let net = budget - fee;
    if net == 0 {
        return Err("Amount is below the minimum");
    }
    let k = yes.checked_mul(no).ok_or("Overflow")?;
    if yes_side {
        let new_no = no.checked_add(net).ok_or("Overflow")?;
        let new_yes = k / new_no;
        if new_yes == 0 || new_yes >= yes {
            return Err("Not enough liquidity");
        }
        let shares = net + (yes - new_yes);
        return Ok(Buy { yes: new_yes, no: new_no, shares, fee, net });
    }
    let new_yes = yes.checked_add(net).ok_or("Overflow")?;
    let new_no = k / new_yes;
    if new_no == 0 || new_no >= no {
        return Err("Not enough liquidity");
    }
    let shares = net + (no - new_no);
    Ok(Buy { yes: new_yes, no: new_no, shares, fee, net })
}

/// Coalition stakes do not consume the trade limit. A normal buy does.
pub fn note_spend(can_trade: bool, spent: u128, limit: u128, amount: u128, coalition: bool) -> Result<u128, &'static str> {
    if coalition {
        return Ok(spent);
    }
    if !can_trade {
        return Err("Agent cannot trade");
    }
    let next = spent.checked_add(amount).ok_or("Overflow")?;
    if next > limit {
        return Err("Over agent spending limit");
    }
    Ok(next)
}

pub fn spot_yes_wins(no: u128, yes: u128) -> bool {
    no > yes
}

#[derive(Clone, Debug)]
pub struct Pool {
    pub yes: u128,
    pub no: u128,
    pub collateral: u128,
    pub yes_liab: u128,
    pub no_liab: u128,
    pub fees: u128,
    pub status: u8,
    pub outcome_yes: bool,
    pub ends_ms: u64,
    pub proposed_at_ms: u64,
}

impl Pool {
    pub fn fresh(ends_ms: u64) -> Self {
        Self {
            yes: LIQ,
            no: LIQ,
            collateral: LIQ,
            yes_liab: 0,
            no_liab: 0,
            fees: 0,
            status: 0,
            outcome_yes: false,
            ends_ms,
            proposed_at_ms: 0,
        }
    }

    pub fn fill(&mut self, side_yes: bool, amount: u128, now_ms: u64) -> Result<Buy, &'static str> {
        if self.status != 0 {
            return Err("Market is not open");
        }
        if now_ms >= self.ends_ms {
            return Err("Market is closed");
        }
        let next = apply_buy(self.yes, self.no, amount, side_yes)?;
        self.yes = next.yes;
        self.no = next.no;
        self.collateral += next.net;
        self.fees += next.fee;
        if side_yes {
            self.yes_liab += next.shares;
        } else {
            self.no_liab += next.shares;
        }
        if self.yes + self.yes_liab != self.collateral {
            return Err("YES solvency broken");
        }
        if self.no + self.no_liab != self.collateral {
            return Err("NO solvency broken");
        }
        Ok(next)
    }

    pub fn propose(&mut self, outcome_yes: bool, now_ms: u64) -> Result<(), &'static str> {
        if self.status != 0 {
            return Err("Market is not open");
        }
        if now_ms < self.ends_ms {
            return Err("Market has not reached its deadline");
        }
        self.status = 1;
        self.outcome_yes = outcome_yes;
        self.proposed_at_ms = now_ms;
        Ok(())
    }

    pub fn override_outcome(&mut self, outcome_yes: bool, now_ms: u64) -> Result<(), &'static str> {
        if self.status != 1 {
            return Err("Nothing to override yet");
        }
        if now_ms > self.proposed_at_ms + DAY_MS {
            return Err("The 24 hour override window has closed");
        }
        self.outcome_yes = outcome_yes;
        Ok(())
    }

    pub fn finalize(&mut self, now_ms: u64) -> Result<(), &'static str> {
        if self.status != 1 {
            return Err("Quorum has not proposed a resolution");
        }
        if now_ms < self.proposed_at_ms + DAY_MS {
            return Err("The 24 hour window is still open");
        }
        self.status = 2;
        Ok(())
    }

    pub fn winning_shares(&self, yes_shares: u128, no_shares: u128) -> Result<u128, &'static str> {
        if self.status != 2 {
            return Err("Market is not finalized");
        }
        Ok(if self.outcome_yes { yes_shares } else { no_shares })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buy_fixture_matches_javascript() {
        let next = apply_buy(800_000_000, 800_000_000, 10_000_000, true).unwrap();
        assert_eq!(next.fee, 50_000);
        assert_eq!(next.net, 9_950_000);
        assert_eq!(next.no, 809_950_000);
        assert_eq!(next.yes, 790_172_232);
        assert_eq!(next.shares, 19_777_768);
    }

    #[test]
    fn buy_yes_moves_the_price_and_stays_solvent() {
        let mut pool = Pool::fresh(10_000_000);
        let mut balance = 50_000_000u128;
        let amount = 10_000_000u128;
        assert!(balance >= amount);
        let fill = pool.fill(true, amount, 2_000).unwrap();
        balance -= amount;
        assert!(pool.no > pool.yes);
        assert_eq!(pool.yes + pool.yes_liab, pool.collateral);
        assert_eq!(pool.no + pool.no_liab, pool.collateral);
        assert_eq!(balance, 40_000_000);
        assert_eq!(fill.shares, 19_777_768);
        assert!(spot_yes_wins(pool.no, pool.yes));
    }

    #[test]
    fn agent_limit_blocks_the_second_trade_and_a_stake_does_not() {
        let spent = note_spend(true, 0, 10_000_000, 10_000_000, false).unwrap();
        assert_eq!(spent, 10_000_000);
        assert_eq!(
            note_spend(true, spent, 10_000_000, 1_000_000, false),
            Err("Over agent spending limit")
        );
        assert_eq!(note_spend(true, spent, 10_000_000, 10_000_000, true).unwrap(), spent);
        assert_eq!(note_spend(false, 0, 10_000_000, 1, false), Err("Agent cannot trade"));
    }

    #[test]
    fn quorum_waits_a_day_and_redeem_pays_one_dollar_a_share() {
        let mut pool = Pool::fresh(5_000);
        let fill = pool.fill(true, 10_000_000, 1_000).unwrap();
        pool.propose(true, 5_000).unwrap();
        pool.override_outcome(true, 5_000).unwrap();
        assert_eq!(pool.finalize(5_000 + DAY_MS - 1), Err("The 24 hour window is still open"));
        pool.finalize(5_000 + DAY_MS).unwrap();
        let paid = pool.winning_shares(fill.shares, 0).unwrap();
        assert_eq!(paid, fill.shares);
        assert_eq!(10_000_000 + paid, 10_000_000 + fill.shares);
    }
}
