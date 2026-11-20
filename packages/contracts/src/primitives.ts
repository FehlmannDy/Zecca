import { z } from 'zod'

/** Opaque id. */
export const Id = z.string().min(1).max(80)
/** ISO 8601 UTC timestamp. */
export const IsoTime = z.iso.datetime()
/** Integer amount in minor units (1 token unit = 1 cent). Never a float. */
export const Minor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
/** Strictly positive minor amount (a payment of 0 is refused). */
export const PositiveMinor = Minor.min(1)
/** Integer amount of XRP in drops (1 XRP = 1 000 000 drops). */
export const Drops = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
/** Classic XRPL address. */
export const XrplAddress = z.string().regex(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/, 'not an XRPL address')
/** Hex public key (secp256k1 compressed, 33 bytes, or ed25519 with ED prefix). */
export const PublicKeyHex = z.string().regex(/^(0[23][0-9A-Fa-f]{64}|ED[0-9A-Fa-f]{64})$/, 'not a public key')
/** Ledger transaction hash, 64 uppercase hex chars. */
export const TxHash = z.string().regex(/^[0-9A-F]{64}$/, 'not a transaction hash')
/** MPT issuance id, 48 hex chars. */
export const IssuanceId = z.string().regex(/^[0-9A-Fa-f]{48}$/, 'not an MPT issuance id')
/** Zecca handle, shown as @handle. */
export const Handle = z.string().regex(/^[a-z0-9_]{3,20}$/, 'Handles are 3 to 20 characters: lowercase letters, digits and _.')
export const Network = z.enum(['devnet', 'testnet'])
export const BasisPoints = z.number().int().min(0).max(10_000)

export type Id = z.infer<typeof Id>
export type IsoTime = z.infer<typeof IsoTime>
export type Minor = z.infer<typeof Minor>
export type XrplAddress = z.infer<typeof XrplAddress>
export type TxHash = z.infer<typeof TxHash>
export type Network = z.infer<typeof Network>
