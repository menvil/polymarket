import type { AccountId, VenueId, WalletAddress } from '@polymarket/ids';

// Тестовые константы для accountId и venueId
export const TEST_ACCOUNT_ID: AccountId = {
  kind: 'WALLET',
  address: '0x1234567890123456789012345678901234567890' as WalletAddress
};

export const TEST_VENUE_ID: VenueId = 'POLYMARKET' as VenueId;
