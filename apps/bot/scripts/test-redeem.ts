/**
 * Тест gasless авто-клейма через Builder Relayer (CLOB V2 / pUSD).
 *
 * Без аргументов: показывает все redeemable позиции.
 * С conditionId: редиет указанную позицию и показывает delta pUSD.
 *
 * @example
 * ```bash
 * npx tsx --env-file=.env scripts/test-redeem.ts
 * npx tsx --env-file=.env scripts/test-redeem.ts <conditionId>
 * ```
 */
import { ethers } from 'ethers';
import { ConsoleLogger, LogLevel } from '@polymarket/logger';
import { PolymarketRedeemExecutor, PUSD_ADDRESS, DEFAULT_POLYGON_RPC } from '../src/bot/PolymarketRedeemExecutor.js';

const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];

async function main(): Promise<void> {
  const funder = process.env['FUNDER_ADDRESS'];
  if (!funder) {
    console.error('Missing env var: FUNDER_ADDRESS');
    process.exit(1);
  }

  const rpcUrl = process.env['POLYGON_RPC_URL'] ?? DEFAULT_POLYGON_RPC;
  const provider = new ethers.JsonRpcProvider(rpcUrl, 137, { staticNetwork: true });
  const pusd = new ethers.Contract(PUSD_ADDRESS, ERC20_ABI, provider);

  const logger = new ConsoleLogger({ now: () => new Date() }, LogLevel.DEBUG);
  const executor = PolymarketRedeemExecutor.fromEnv(logger);

  // Список redeemable позиций
  const positions = await executor.getRedeemablePositions();
  console.log(`Redeemable positions: ${positions.length}`);
  for (const p of positions) {
    console.log(`  conditionId=${p.conditionId} size=${p.size} value=${p.currentValue}`);
  }

  const conditionId = process.argv[2];
  if (!conditionId) {
    console.log('\nUsage: npx tsx --env-file=.env scripts/test-redeem.ts <conditionId>');
    return;
  }

  const balanceBefore = await pusd.balanceOf(funder) as bigint;
  console.log(`\npUSD before: ${ethers.formatUnits(balanceBefore, 6)}`);
  console.log(`Redeeming conditionId: ${conditionId}`);

  const result = await executor.redeem(conditionId, { metadataPrefix: 'TestRedeem', skipOraclePrecheck: false });
  console.log('Result:', result);

  const balanceAfter = await pusd.balanceOf(funder) as bigint;
  const diff = balanceAfter - balanceBefore;
  console.log(`pUSD after:  ${ethers.formatUnits(balanceAfter, 6)}`);
  if (diff > 0n) {
    console.log(`CLAIMED: +${ethers.formatUnits(diff, 6)} pUSD`);
  } else {
    console.log('No pUSD delta (already redeemed or reverted)');
  }
}

main().catch(console.error);
