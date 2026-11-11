// Pencils data model. Mirrors the prototype in source/pencils.html.
// Prices are probabilities in 0..1. One share pays $1 if its side wins.

export type Side = 'yes' | 'no';
export type SourceType = 'x' | 'news' | 'agent' | 'you';

export interface Market {
  id: string;                 // slug, also used in the URL as #m-<id>
  title: string;              // the thesis; wrap the key figure in [[...]] to render the highlight
  p: number;                  // current Yes probability (No = 1 - p)
  vol: number;                // total volume in USD
  ends: number;               // close time, unix ms
  src: [SourceType, string];  // source type + label, e.g. ['x', 'Trending on X, 48.2K posts']
  by: string;                 // proposer agent id, or 'you'
  co: [agentId: string, stake: number][]; // coalition members and USD staked
  counter?: string;           // id of the opposing market, if one exists
  counterOf?: string;         // set when this market is itself a counter-market
  ct?: string;                // pre-written counter thesis used when someone opens a counter-market
  traders: number;
  sum: string;                // consensus summary template; '{p}' is replaced with the live percentage
  crit: string;               // resolution criteria in plain language
  hist: number[];             // probability history, newest last (200 points in the prototype)
  trades: Trade[];
  created?: number;           // set for user-created markets, sorts them to the top
}

export interface Agent {
  id: string;
  name: string;
  handle: string;             // NEAR account, e.g. 'pulse.pencils.near' or 'agent-1.you.near'
  glyph: 'circle' | 'square' | 'tri' | 'diamond' | 'ring' | 'plus' | 'bars' | 'half';
  // system agents
  role?: string; acc?: number; props?: number;
  // user agents
  kind?: 'near' | 'api';
  perms?: { propose: boolean; trade: boolean };
  limit?: number;             // spending limit in USD
  spent?: number;
  created?: number;
}

export interface Position {
  id: string;
  mid: string;                // market id
  side: Side;
  shares: number;             // amount / price at purchase
  cost: number;               // USD paid
  via: 'me' | string;         // 'me' for manual bets, otherwise the agent id that placed it
  t: number;
}

export interface Trade { who: string; side: Side; amt: number; ago: number } // who: agent id or 'h:<account>'
export interface SwarmEvent { html: string; t: number }                      // live activity line

export interface ResolvedPosition { t: string; side: Side; cost: number; pay: number; won: boolean; date: string }

// Pricing used in the prototype
export const price = (m: Market, side: Side) => (side === 'yes' ? m.p : 1 - m.p);
export const shares = (amount: number, px: number) => amount / px;
export const payout = (sh: number) => sh * 1;                   // $1 per winning share
export const positionValue = (pos: Position, m: Market) => pos.shares * price(m, pos.side);
// Price impact placeholder: move toward the bought side by min(4 points, amount / (volume / 25))
export const impact = (m: Market, amount: number) => Math.min(0.04, amount / (m.vol / 25));
