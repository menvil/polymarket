/**
 * Тест gasless авто-клейма через Builder Relayer.
 *
 * @remarks
 * Проверяет:
 * 1. Подключение к Builder Relayer
 * 2. Аутентификация с Builder API keys
 * 3. Отправка redeemPositions через proxy-кошелёк
 *
 * @example
 * ```bash
 * npx tsx scripts/test-redeem.ts <conditionId>
 * ```
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { ethers } from 'ethers';
import { RelayClient, RelayerTxType } from '@polymarket/builder-relayer-client';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';

// Загружаем .env вручную (без dotenv)
try {
  const envPath = resolve(import.meta.dirname ?? '.', '..', '.env');
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match && !process.env[match[1].trim()]) {
      process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
    }
  }
} catch { /* .env не найден */ }

const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const USDC_E_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];
const CTF_INTERFACE = new ethers.Interface([
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
]);

async function main(): Promise<void> {
  const pk = process.env['PRIVATE_KEY'];
  const funder = process.env['FUNDER_ADDRESS'];
  const builderKey = process.env['BUILDER_API_KEY'];
  const builderSecret = process.env['BUILDER_API_SECRET'];
  const builderPassphrase = process.env['BUILDER_API_PASSPHRASE'];

  if (!pk || !funder || !builderKey || !builderSecret || !builderPassphrase) {
    console.error('Missing env vars: PRIVATE_KEY, FUNDER_ADDRESS, BUILDER_API_KEY, BUILDER_API_SECRET, BUILDER_API_PASSPHRASE');
    process.exit(1);
  }

  const rpcUrl = process.env['POLYGON_RPC_URL'] || 'https://polygon-bor-rpc.publicnode.com';
  const provider = new ethers.JsonRpcProvider(rpcUrl, 137, { staticNetwork: true });
  const wallet = new ethers.Wallet(pk, provider);

  console.log('EOA:', wallet.address);
  console.log('Proxy (funder):', funder);

  // Проверяем баланс proxy
  const usdc = new ethers.Contract(USDC_E_ADDRESS, ERC20_ABI, provider);
  const proxyUsdcBefore = await usdc.balanceOf(funder);
  console.log('Proxy USDC.e before:', ethers.formatUnits(proxyUsdcBefore, 6));

  // Создаём Builder Relayer клиент
  console.log('\nCreating RelayClient...');
  const builderConfig = new BuilderConfig({
    localBuilderCreds: {
      key: builderKey,
      secret: builderSecret,
      passphrase: builderPassphrase,
    },
  });

  const relayClient = new RelayClient(
    'https://relayer-v2.polymarket.com',
    137,
    wallet as any, // ethers v6 Wallet
    builderConfig,
    RelayerTxType.PROXY,
  );
  console.log('RelayClient created OK');

  // conditionId из аргумента
  const conditionId = process.argv[2];
  if (!conditionId) {
    console.log('\nNo conditionId provided. Usage: npx tsx scripts/test-redeem.ts <conditionId>');
    console.log('Skipping redeem test. Client setup is OK.');
    return;
  }

  console.log('\n--- Testing gasless redeem ---');
  console.log('conditionId:', conditionId);

  // Кодируем calldata
  const calldata = CTF_INTERFACE.encodeFunctionData('redeemPositions', [
    USDC_E_ADDRESS,
    ethers.ZeroHash,
    conditionId,
    [1, 2],
  ]);

  const tx = {
    to: CTF_ADDRESS,
    data: calldata,
    value: '0x0',
  };

  try {
    console.log('Submitting to relayer...');
    const response = await relayClient.execute([tx], `Redeem: ${conditionId.slice(0, 10)}`);
    console.log('Relayer response:', JSON.stringify(response, null, 2));

    if (response.transactionId) {
      console.log('Transaction ID:', response.transactionId);
      console.log('Waiting for confirmation...');
      const receipt = await response.wait();
      console.log('Status:', receipt.status);
      console.log('TX hash:', receipt.transactionHash);

      const proxyUsdcAfter = await usdc.balanceOf(funder);
      const diff = proxyUsdcAfter - proxyUsdcBefore;
      console.log('Proxy USDC.e after:', ethers.formatUnits(proxyUsdcAfter, 6));
      if (diff > 0n) {
        console.log('CLAIMED:', ethers.formatUnits(diff, 6), 'USDC.e');
      } else {
        console.log('No USDC.e received (already redeemed or no winning tokens)');
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('ERROR:', msg.slice(0, 500));
    if (err instanceof Error && err.cause) {
      console.error('Cause:', String(err.cause));
    }
  }
}

main().catch(console.error);
