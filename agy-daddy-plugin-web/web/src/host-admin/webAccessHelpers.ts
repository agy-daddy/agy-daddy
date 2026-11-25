import type { I18nKey, TranslateFn } from '../i18n';
import type { AccessChannel, CloudflareStateInfo } from '../types';

export const ACCESS_CHANNEL_ORDER: AccessChannel[] = [
  'cloudflare',
  'tailscale',
  'lan',
  'bonjour',
  'loopback',
];

export const CHANNEL_LABEL_KEY: Record<AccessChannel, I18nKey> = {
  cloudflare: 'webAccess.channel.cloudflare',
  tailscale: 'webAccess.channel.tailscale',
  lan: 'webAccess.channel.lan',
  bonjour: 'webAccess.channel.bonjour',
  loopback: 'webAccess.channel.loopback',
};

export const CHANNEL_SHORT_LABEL_KEY: Record<AccessChannel, I18nKey> = {
  cloudflare: 'webAccess.channelShort.cloudflare',
  tailscale: 'webAccess.channelShort.tailscale',
  lan: 'webAccess.channelShort.lan',
  bonjour: 'webAccess.channelShort.bonjour',
  loopback: 'webAccess.channelShort.loopback',
};

export function formatCloudflareGuidance(
  cfState: CloudflareStateInfo | null | undefined,
  t: TranslateFn,
): { message: string; tone: 'info' | 'warn' } | null {
  if (!cfState || cfState.mode === 'disabled') return null;
  switch (cfState.mode) {
    case 'shared_ready':
      return {
        tone: 'info',
        message: t(
          cfState.tunnelMode === 'named'
            ? 'webAccess.cf.sharedReadyNamed'
            : 'webAccess.cf.sharedReadyQuick',
        ),
      };
    case 'web_disabled':
      return { tone: 'warn', message: t('webAccess.cf.webDisabled') };
    case 'remote_pending':
      return { tone: 'info', message: t('webAccess.cf.remotePending') };
    case 'remote_error':
      return {
        tone: 'warn',
        message: t('webAccess.cf.remoteError', {
          reason: cfState.reasonCode || 'ERROR',
        }),
      };
    case 'remote_tunnel_off':
      return { tone: 'warn', message: t('webAccess.cf.remoteTunnelOff') };
    case 'legacy_standalone':
      return { tone: 'warn', message: t('webAccess.cf.legacyStandalone') };
    case 'remote_unavailable':
      return { tone: 'warn', message: t('webAccess.cf.remoteUnavailable') };
    default:
      return null;
  }
}
