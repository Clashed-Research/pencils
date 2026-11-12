//! Pencils market contract.
//! Pool math and the 24 hour resolution window live in `pencils-market`
//! so the same rules run under `cargo test` without a WASM runtime.

use near_sdk::json_types::U128;
use near_sdk::store::IterableMap;
use near_sdk::{env, near, require, AccountId, NearToken, Promise};
use pencils_market::{note_spend, Pool};

const LIQ: u128 = pencils_market::LIQ;

#[derive(Clone)]
#[near(serializers = [borsh, json])]
pub struct Market {
    pub title: String,
    pub criteria: String,
    pub ends_ms: u64,
    pub proposer: AccountId,
    pub yes_reserve: u128,
    pub no_reserve: u128,
    pub collateral: u128,
    pub yes_liab: u128,
    pub no_liab: u128,
    pub fees: u128,
    pub status: u8,
    pub outcome_yes: bool,
    pub proposed_at_ms: u64,
    pub counter_of: String,
}

#[derive(Clone)]
#[near(serializers = [borsh, json])]
pub struct Position {
    pub yes_shares: u128,
    pub no_shares: u128,
}

#[near(serializers = [json])]
pub struct Funds {
    pub balance: U128,
    pub escrow: U128,
    pub locked: U128,
    pub pending: U128,
}

#[derive(Clone)]
#[near(serializers = [borsh, json])]
pub struct Policy {
    pub parent: AccountId,
    pub can_propose: bool,
    pub can_trade: bool,
    pub limit: u128,
    pub spent: u128,
}

#[near(contract_state)]
pub struct Pencils {
    owner: AccountId,
    quorum: AccountId,
    markets: IterableMap<String, Market>,
    balances: IterableMap<AccountId, u128>,
    positions: IterableMap<String, Position>,
    policies: IterableMap<AccountId, Policy>,
}

fn pool_of(market: &Market) -> Pool {
    Pool {
        yes: market.yes_reserve,
        no: market.no_reserve,
        collateral: market.collateral,
        yes_liab: market.yes_liab,
        no_liab: market.no_liab,
        fees: market.fees,
        status: market.status,
        outcome_yes: market.outcome_yes,
        ends_ms: market.ends_ms,
        proposed_at_ms: market.proposed_at_ms,
    }
}

fn write_pool(market: &mut Market, pool: &Pool) {
    market.yes_reserve = pool.yes;
    market.no_reserve = pool.no;
    market.collateral = pool.collateral;
    market.yes_liab = pool.yes_liab;
    market.no_liab = pool.no_liab;
    market.fees = pool.fees;
    market.status = pool.status;
    market.outcome_yes = pool.outcome_yes;
    market.proposed_at_ms = pool.proposed_at_ms;
}

#[near]
impl Pencils {
    #[init]
    pub fn new(owner: AccountId, quorum: AccountId) -> Self {
        Self {
            owner,
            quorum,
            markets: IterableMap::new(b"m"),
            balances: IterableMap::new(b"b"),
            positions: IterableMap::new(b"p"),
            policies: IterableMap::new(b"a"),
        }
    }

    /// Demo faucet. Production credits come from a USDC `ft_on_transfer`.
    pub fn credit(&mut self, account: AccountId, amount: U128) {
        self.assert_owner();
        let next = self.balances.get(&account).copied().unwrap_or(0) + amount.0;
        self.balances.insert(account, next);
    }

    pub fn set_agent_policy(&mut self, agent: AccountId, can_propose: bool, can_trade: bool, limit: U128) {
        let parent = env::predecessor_account_id();
        self.policies.insert(
            agent,
            Policy { parent, can_propose, can_trade, limit: limit.0, spent: 0 },
        );
    }

    pub fn create_market(&mut self, id: String, title: String, criteria: String, ends_ms: u64) {
        require!(!self.markets.contains_key(&id), "Market exists");
        let proposer = env::predecessor_account_id();
        if let Some(policy) = self.policies.get(&proposer) {
            require!(policy.can_propose, "Agent cannot propose");
        }
        self.markets.insert(
            id,
            Market {
                title,
                criteria,
                ends_ms,
                proposer,
                yes_reserve: LIQ,
                no_reserve: LIQ,
                collateral: LIQ,
                yes_liab: 0,
                no_liab: 0,
                fees: 0,
                status: 0,
                outcome_yes: false,
                proposed_at_ms: 0,
                counter_of: String::new(),
            },
        );
    }

    pub fn buy(&mut self, market_id: String, side: String, amount: U128) -> U128 {
        self.fill(&market_id, &side, amount.0, false);
        let pos = self.position_of(&env::predecessor_account_id(), &market_id);
        U128(if side == "yes" { pos.yes_shares } else { pos.no_shares })
    }

    pub fn stake(&mut self, market_id: String, amount: U128) {
        self.fill(&market_id, "yes", amount.0, true);
    }

    pub fn propose_resolution(&mut self, market_id: String, outcome: String, _evidence: String) {
        require!(env::predecessor_account_id() == self.quorum, "Only Quorum resolves");
        require!(outcome == "yes" || outcome == "no", "Outcome must be yes or no");
        let now = self.now_ms();
        let mut market = self.markets.get(&market_id).expect("Market not found").clone();
        let mut pool = pool_of(&market);
        pool.propose(outcome == "yes", now).expect("Resolution rejected");
        write_pool(&mut market, &pool);
        self.markets.insert(market_id, market);
    }

    pub fn override_resolution(&mut self, market_id: String, outcome: String) {
        self.assert_owner();
        require!(outcome == "yes" || outcome == "no", "Outcome must be yes or no");
        let now = self.now_ms();
        let mut market = self.markets.get(&market_id).expect("Market not found").clone();
        let mut pool = pool_of(&market);
        pool.override_outcome(outcome == "yes", now).expect("Override rejected");
        write_pool(&mut market, &pool);
        self.markets.insert(market_id, market);
    }

    pub fn finalize(&mut self, market_id: String) {
        let now = self.now_ms();
        let mut market = self.markets.get(&market_id).expect("Market not found").clone();
        let mut pool = pool_of(&market);
        pool.finalize(now).expect("Finalize rejected");
        write_pool(&mut market, &pool);
        self.markets.insert(market_id, market);
    }

    /// Pay $1 per winning share back to the caller's internal balance.
    pub fn redeem(&mut self, market_id: String) -> U128 {
        let market = self.markets.get(&market_id).expect("Market not found").clone();
        let pool = pool_of(&market);
        let account = env::predecessor_account_id();
        let key = pos_key(&account, &market_id);
        let pos = self.positions.get(&key).cloned().unwrap_or(Position { yes_shares: 0, no_shares: 0 });
        let shares = pool.winning_shares(pos.yes_shares, pos.no_shares).expect("Redeem rejected");
        self.positions.insert(key, Position { yes_shares: 0, no_shares: 0 });
        let next = self.balances.get(&account).copied().unwrap_or(0) + shares;
        self.balances.insert(account, next);
        U128(shares)
    }

    pub fn get_balance(&self, account: AccountId) -> U128 {
        U128(self.balances.get(&account).copied().unwrap_or(0))
    }

    pub fn get_market(&self, id: String) -> Option<Market> {
        self.markets.get(&id).cloned()
    }

    /// Record a wallet login. The chain checks the signature; the app checks the receipt.
    pub fn register(&mut self) {
        env::log_str(&format!("pencils:register:{}", env::predecessor_account_id()));
    }

    /// 1 NEAR credits $1 (1_000_000 micro). The NEAR stays here until withdraw or settlement.
    #[payable]
    pub fn deposit(&mut self) {
        let account = env::predecessor_account_id();
        let yocto = env::attached_deposit().as_yoctonear();
        let credit = yocto / YOCTO_PER_MICRO;
        require!(credit >= 1_000, "Attach at least 0.001 NEAR");
        let next = self.balances.get(&account).copied().unwrap_or(0) + credit;
        self.balances.insert(account.clone(), next);
        write_u128(&escrow_key(&account), read_u128(&escrow_key(&account)) + yocto);
        env::log_str(&format!("pencils:deposit:{account}:{yocto}"));
    }

    /// Move available credit into a pending lock. The app claims it when the bet is recorded.
    pub fn lock(&mut self, amount: U128) {
        require!(amount.0 > 0, "Amount must be positive");
        let account = env::predecessor_account_id();
        let balance = self.balances.get(&account).copied().unwrap_or(0);
        require!(balance >= amount.0, "Not enough balance");
        let yocto = micro_to_yocto(amount.0);
        let held = read_u128(&escrow_key(&account));
        let busy = read_u128(&locked_key(&account)) + read_u128(&pending_key(&account));
        require!(held >= busy + yocto, "Not enough NEAR");
        self.balances.insert(account.clone(), balance - amount.0);
        write_u128(&pending_key(&account), read_u128(&pending_key(&account)) + yocto);
    }

    /// The account owner accepts a pending lock after the bet is about to be recorded.
    pub fn claim(&mut self, account: AccountId, amount: U128) {
        self.assert_owner();
        require!(amount.0 > 0, "Amount must be positive");
        let yocto = micro_to_yocto(amount.0);
        let pending = read_u128(&pending_key(&account));
        require!(pending >= yocto, "Not enough pending");
        write_u128(&pending_key(&account), pending - yocto);
        write_u128(&locked_key(&account), read_u128(&locked_key(&account)) + yocto);
    }

    /// Return every unclaimed lock to the caller's available balance.
    pub fn cancel(&mut self) {
        let account = env::predecessor_account_id();
        let pending = read_u128(&pending_key(&account));
        if pending == 0 {
            return;
        }
        let credit = pending / YOCTO_PER_MICRO;
        write_u128(&pending_key(&account), 0);
        let next = self.balances.get(&account).copied().unwrap_or(0) + credit;
        self.balances.insert(account, next);
    }

    /// Send available NEAR back to the signing wallet. Unclaimed locks are returned first.
    pub fn withdraw(&mut self, amount: U128) -> Promise {
        let account = env::predecessor_account_id();
        let pending = read_u128(&pending_key(&account));
        if pending > 0 {
            let credit = pending / YOCTO_PER_MICRO;
            write_u128(&pending_key(&account), 0);
            let next = self.balances.get(&account).copied().unwrap_or(0) + credit;
            self.balances.insert(account.clone(), next);
        }
        require!(amount.0 > 0, "Amount must be positive");
        let balance = self.balances.get(&account).copied().unwrap_or(0);
        require!(balance >= amount.0, "Not enough balance");
        let yocto = micro_to_yocto(amount.0);
        let held = read_u128(&escrow_key(&account));
        let locked = read_u128(&locked_key(&account));
        require!(held >= locked + yocto, "NEAR is locked in open positions");
        self.balances.insert(account.clone(), balance - amount.0);
        write_u128(&escrow_key(&account), held - yocto);
        Promise::new(account).transfer(NearToken::from_yoctonear(yocto))
    }

    /// Return locked NEAR to the user's available balance.
    pub fn release(&mut self, account: AccountId, amount: U128) {
        self.assert_owner();
        require!(amount.0 > 0, "Amount must be positive");
        let yocto = micro_to_yocto(amount.0);
        let locked = read_u128(&locked_key(&account));
        require!(locked >= yocto, "Not enough locked");
        write_u128(&locked_key(&account), locked - yocto);
        let next = self.balances.get(&account).copied().unwrap_or(0) + amount.0;
        self.balances.insert(account, next);
    }

    /// Take a losing stake out of the user's escrow and into the settlement pot.
    pub fn slash(&mut self, account: AccountId, amount: U128) {
        self.assert_owner();
        require!(amount.0 > 0, "Amount must be positive");
        let yocto = micro_to_yocto(amount.0);
        let locked = read_u128(&locked_key(&account));
        require!(locked >= yocto, "Not enough locked");
        let held = read_u128(&escrow_key(&account));
        require!(held >= yocto, "Not enough escrow");
        write_u128(&locked_key(&account), locked - yocto);
        write_u128(&escrow_key(&account), held - yocto);
        write_u128(b"pot1", read_u128(b"pot1") + yocto);
    }

    /// Pay a winner their stake back, plus extra NEAR taken from losing stakes.
    pub fn payout(&mut self, account: AccountId, release_amount: U128, extra: U128) {
        self.assert_owner();
        if release_amount.0 > 0 {
            let yocto = micro_to_yocto(release_amount.0);
            let locked = read_u128(&locked_key(&account));
            require!(locked >= yocto, "Not enough locked");
            write_u128(&locked_key(&account), locked - yocto);
            let next = self.balances.get(&account).copied().unwrap_or(0) + release_amount.0;
            self.balances.insert(account.clone(), next);
        }
        if extra.0 > 0 {
            let yocto = micro_to_yocto(extra.0);
            let pot = read_u128(b"pot1");
            require!(pot >= yocto, "Not enough pot");
            write_u128(b"pot1", pot - yocto);
            write_u128(&escrow_key(&account), read_u128(&escrow_key(&account)) + yocto);
            let next = self.balances.get(&account).copied().unwrap_or(0) + extra.0;
            self.balances.insert(account, next);
        }
    }

    pub fn get_funds(&self, account: AccountId) -> Funds {
        Funds {
            balance: U128(self.balances.get(&account).copied().unwrap_or(0)),
            escrow: U128(read_u128(&escrow_key(&account))),
            locked: U128(read_u128(&locked_key(&account))),
            pending: U128(read_u128(&pending_key(&account))),
        }
    }
}

impl Default for Pencils {
    fn default() -> Self {
        Self::new("owner.near".parse().unwrap(), "quorum.near".parse().unwrap())
    }
}

impl Pencils {
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "Only the Pencils owner");
    }

    fn now_ms(&self) -> u64 {
        env::block_timestamp() / 1_000_000
    }

    fn fill(&mut self, market_id: &str, side: &str, amount: u128, coalition: bool) {
        require!(side == "yes" || side == "no", "Side must be yes or no");
        let account = env::predecessor_account_id();
        let now = self.now_ms();
        let mut market = self.markets.get(&market_id.to_string()).expect("Market not found").clone();
        if let Some(policy) = self.policies.get(&account).cloned() {
            let spent = note_spend(policy.can_trade, policy.spent, policy.limit, amount, coalition).expect("Policy rejected");
            if !coalition {
                let mut policy = policy;
                policy.spent = spent;
                self.policies.insert(account.clone(), policy);
            }
        }
        let balance = self.balances.get(&account).copied().unwrap_or(0);
        require!(balance >= amount, "Not enough balance");
        let mut pool = pool_of(&market);
        let next = pool.fill(side == "yes", amount, now).expect("Trade rejected");
        write_pool(&mut market, &pool);
        self.markets.insert(market_id.to_string(), market);
        self.balances.insert(account.clone(), balance - amount);
        let key = pos_key(&account, market_id);
        let mut pos = self.positions.get(&key).cloned().unwrap_or(Position { yes_shares: 0, no_shares: 0 });
        if side == "yes" {
            pos.yes_shares += next.shares;
        } else {
            pos.no_shares += next.shares;
        }
        self.positions.insert(key, pos);
    }

    fn position_of(&self, account: &AccountId, market_id: &str) -> Position {
        self.positions
            .get(&pos_key(account, market_id))
            .cloned()
            .unwrap_or(Position { yes_shares: 0, no_shares: 0 })
    }
}

fn pos_key(account: &AccountId, market_id: &str) -> String {
    format!("{account}:{market_id}")
}

const YOCTO_PER_MICRO: u128 = 1_000_000_000_000_000_000;

fn micro_to_yocto(micro: u128) -> u128 {
    micro.checked_mul(YOCTO_PER_MICRO).expect("Overflow")
}

fn escrow_key(account: &AccountId) -> Vec<u8> {
    let mut key = b"esc1".to_vec();
    key.extend(account.as_bytes());
    key
}

fn locked_key(account: &AccountId) -> Vec<u8> {
    let mut key = b"lck1".to_vec();
    key.extend(account.as_bytes());
    key
}

fn pending_key(account: &AccountId) -> Vec<u8> {
    let mut key = b"pnd1".to_vec();
    key.extend(account.as_bytes());
    key
}

fn read_u128(key: &[u8]) -> u128 {
    match env::storage_read(key) {
        Some(bytes) if bytes.len() == 16 => {
            let mut buf = [0u8; 16];
            buf.copy_from_slice(&bytes);
            u128::from_le_bytes(buf)
        }
        _ => 0,
    }
}

fn write_u128(key: &[u8], value: u128) {
    if value == 0 {
        env::storage_remove(key);
    } else {
        env::storage_write(key, &value.to_le_bytes());
    }
}
