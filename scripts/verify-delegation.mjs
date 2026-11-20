// Vérifie la délégation de paiement XRPL (PermissionDelegationV1_1) sur testnet ou devnet.
// Usage : npm i xrpl@5 && node verify-delegation.mjs [testnet|devnet]
import xrpl from 'xrpl';
import { createHash } from 'node:crypto';

const NETS = {
  testnet: { ws: 'wss://s.altnet.rippletest.net:51233', explorer: 'https://testnet.xrpl.org/transactions/' },
  devnet:  { ws: 'wss://s.devnet.rippletest.net:51233', explorer: 'https://devnet.xrpl.org/transactions/' },
};
const netName = process.argv[2] === 'devnet' ? 'devnet' : 'testnet';
const net = NETS[netName];

// ID d'un amendement = 256 premiers bits du SHA-512 de son nom
const AMENDMENT = 'PermissionDelegationV1_1';
const amendmentId = createHash('sha512').update(AMENDMENT).digest('hex').slice(0, 64).toUpperCase();
const AMENDMENTS_INDEX = '7DB0788C020F02780A673DC74757F23823FA3014C1866E72CC4CD8B226CD6EF4';

const client = new xrpl.Client(net.ws);
const xrp = async (addr) => (await client.getXrpBalance(addr)).toString();
const result = (r) => r.result.meta?.TransactionResult ?? r.result.engine_result;

async function delegatedPay(user, card, merchant, amount) {
  const tx = {
    TransactionType: 'Payment',
    Account: user.address,      // le client (délégant) : les fonds sortent de SON compte
    Delegate: card.address,     // le compte "carte" (délégué) : signe et paie les frais
    Destination: merchant.address,
    Amount: xrpl.xrpToDrops(amount),
  };
  try {
    return await client.submitAndWait(tx, { wallet: card, autofill: true });
  } catch (e) {
    return { result: { engine_result: e.data?.engine_result ?? e.message } };
  }
}

await client.connect();
console.log(`Réseau : ${netName} (${net.ws})`);

// 1) L'amendement est-il actif sur ce réseau ?
const { result: amend } = await client.request({ command: 'ledger_entry', index: AMENDMENTS_INDEX, ledger_index: 'validated' });
const enabled = amend.node.Amendments.includes(amendmentId);
console.log(`${AMENDMENT} (${amendmentId.slice(0, 12)}…) actif : ${enabled ? 'OUI' : 'NON'}`);
if (!enabled) { await client.disconnect(); process.exit(1); }

// 2) Trois comptes : client, carte (délégué), marchand
const [{ wallet: user }, { wallet: card }, { wallet: merchant }] = await Promise.all([
  client.fundWallet(), client.fundWallet(), client.fundWallet(),
]);
console.log(`client   ${user.address}\ncarte    ${card.address}\nmarchand ${merchant.address}`);

// 3) Le client autorise UNE fois la carte à faire des Payment pour lui (signé par le client)
const grant = await client.submitAndWait({
  TransactionType: 'DelegateSet',
  Account: user.address,
  Authorize: card.address,
  Permissions: [{ Permission: { PermissionValue: 'Payment' } }],
}, { wallet: user, autofill: true });
console.log(`DelegateSet : ${result(grant)}  ${net.explorer}${grant.result.hash}`);

// 4) "Tap" : la carte paie 5 XRP depuis le compte du client vers le marchand
const before = { user: await xrp(user.address), merchant: await xrp(merchant.address) };
const pay = await delegatedPay(user, card, merchant, '5');
const after = { user: await xrp(user.address), merchant: await xrp(merchant.address) };
console.log(`Paiement délégué : ${result(pay)}  ${pay.result.hash ? net.explorer + pay.result.hash : ''}`);
console.log(`  client   ${before.user} -> ${after.user} XRP`);
console.log(`  marchand ${before.merchant} -> ${after.merchant} XRP`);

// 5) Le client révoque (Permissions vide = suppression), puis la carte retente
const revoke = await client.submitAndWait({
  TransactionType: 'DelegateSet', Account: user.address, Authorize: card.address, Permissions: [],
}, { wallet: user, autofill: true });
console.log(`Révocation : ${result(revoke)}`);
const pay2 = await delegatedPay(user, card, merchant, '5');
console.log(`Paiement après révocation (doit échouer) : ${result(pay2)}`);

await client.disconnect();
