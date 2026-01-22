import { useMemo, useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  IconKey,
  IconBot,
  IconFileText,
  IconSatellite,
  IconRefreshCw,
} from '@/components/ui/icons';
import { Button } from '@/components/ui/Button';
import { useAuthStore, useConfigStore, useModelsStore, useQuotaStore } from '@/stores';
import { apiKeysApi, providersApi, authFilesApi } from '@/services/api';
import { ANTIGRAVITY_CONFIG, CODEX_CONFIG, GEMINI_CLI_CONFIG } from '@/components/quota';
import type { AuthFileItem } from '@/types';
import styles from './DashboardPage.module.scss';

interface QuickStat {
  label: string;
  value: number | string;
  icon: React.ReactNode;
  path: string;
  loading?: boolean;
  sublabel?: string;
}

interface ProviderStats {
  gemini: number | null;
  codex: number | null;
  claude: number | null;
  openai: number | null;
}

export function DashboardPage() {
  const { t, i18n } = useTranslation();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const serverVersion = useAuthStore((state) => state.serverVersion);
  const serverBuildDate = useAuthStore((state) => state.serverBuildDate);
  const apiBase = useAuthStore((state) => state.apiBase);
  const config = useConfigStore((state) => state.config);

  // Quota store data
  const antigravityQuota = useQuotaStore((state) => state.antigravityQuota);
  const codexQuota = useQuotaStore((state) => state.codexQuota);
  const geminiCliQuota = useQuotaStore((state) => state.geminiCliQuota);

  // Aggregate quota data from cached store
  const quotaSummary = useMemo(() => {
    interface QuotaItem {
      id: string;
      label: string;
      percent: number;
    }

    interface ProviderSummary {
      name: string;
      credentialCount: number;
      items: QuotaItem[];
    }

    const providers: ProviderSummary[] = [];

    // Antigravity (Google/Vertex)
    const antigravityEntries = Object.entries(antigravityQuota).filter(
      ([, q]) => q.status === 'success' && q.groups.length > 0
    );
    if (antigravityEntries.length > 0) {
      const groupMap = new Map<string, { total: number; count: number }>();
      antigravityEntries.forEach(([, q]) => {
        q.groups.forEach((group) => {
          const existing = groupMap.get(group.id);
          const percent = Math.round(group.remainingFraction * 100);
          if (existing) {
            existing.total += percent;
            existing.count += 1;
          } else {
            groupMap.set(group.id, { total: percent, count: 1 });
          }
        });
      });
      const items: QuotaItem[] = [];
      // Get first credential's groups for labels
      const firstGroups = antigravityEntries[0][1].groups;
      firstGroups.forEach((group) => {
        const agg = groupMap.get(group.id);
        if (agg) {
          items.push({
            id: group.id,
            label: group.label,
            percent: Math.round(agg.total / agg.count),
          });
        }
      });
      providers.push({
        name: 'Antigravity',
        credentialCount: antigravityEntries.length,
        items: items.slice(0, 5), // Limit to 5 items
      });
    }

    // Codex (ChatGPT/OpenAI)
    const codexEntries = Object.entries(codexQuota).filter(
      ([, q]) => q.status === 'success' && q.windows.length > 0
    );
    if (codexEntries.length > 0) {
      const windowMap = new Map<string, { total: number; count: number; label: string }>();
      codexEntries.forEach(([, q]) => {
        q.windows.forEach((w) => {
          const remaining = w.usedPercent !== null ? Math.max(0, 100 - w.usedPercent) : null;
          if (remaining === null) return;
          const existing = windowMap.get(w.id);
          if (existing) {
            existing.total += remaining;
            existing.count += 1;
          } else {
            windowMap.set(w.id, { total: remaining, count: 1, label: w.label });
          }
        });
      });
      const items: QuotaItem[] = [];
      windowMap.forEach((agg, id) => {
        items.push({
          id,
          label: agg.label,
          percent: Math.round(agg.total / agg.count),
        });
      });
      providers.push({
        name: 'Codex',
        credentialCount: codexEntries.length,
        items,
      });
    }

    // Gemini CLI
    const geminiEntries = Object.entries(geminiCliQuota).filter(
      ([, q]) => q.status === 'success' && q.buckets.length > 0
    );
    if (geminiEntries.length > 0) {
      const bucketMap = new Map<string, { total: number; count: number; label: string }>();
      geminiEntries.forEach(([, q]) => {
        q.buckets.forEach((bucket) => {
          const percent =
            bucket.remainingFraction !== null ? Math.round(bucket.remainingFraction * 100) : null;
          if (percent === null) return;
          const existing = bucketMap.get(bucket.id);
          if (existing) {
            existing.total += percent;
            existing.count += 1;
          } else {
            bucketMap.set(bucket.id, { total: percent, count: 1, label: bucket.label });
          }
        });
      });
      const items: QuotaItem[] = [];
      bucketMap.forEach((agg, id) => {
        items.push({
          id,
          label: agg.label,
          percent: Math.round(agg.total / agg.count),
        });
      });
      providers.push({
        name: 'Gemini CLI',
        credentialCount: geminiEntries.length,
        items: items.slice(0, 5), // Limit to 5 items
      });
    }

    return providers;
  }, [antigravityQuota, codexQuota, geminiCliQuota]);

  const hasQuotaData = quotaSummary.length > 0;

  const setAntigravityQuota = useQuotaStore((state) => state.setAntigravityQuota);
  const setCodexQuota = useQuotaStore((state) => state.setCodexQuota);
  const setGeminiCliQuota = useQuotaStore((state) => state.setGeminiCliQuota);

  const [quotaRefreshing, setQuotaRefreshing] = useState(false);

  const refreshAllQuota = useCallback(async () => {
    if (quotaRefreshing || connectionStatus !== 'connected') return;

    setQuotaRefreshing(true);
    try {
      const filesResponse = await authFilesApi.list();
      const files: AuthFileItem[] = filesResponse?.files || [];

      const antigravityFiles = files.filter(ANTIGRAVITY_CONFIG.filterFn);
      const codexFiles = files.filter(CODEX_CONFIG.filterFn);
      const geminiFiles = files.filter(GEMINI_CLI_CONFIG.filterFn);

      const fetchForConfig = async (
        configFiles: AuthFileItem[],
        config: typeof ANTIGRAVITY_CONFIG | typeof CODEX_CONFIG | typeof GEMINI_CLI_CONFIG,
        setter: (updater: any) => void
      ) => {
        if (configFiles.length === 0) return;

        setter((prev: Record<string, unknown>) => {
          const next = { ...prev };
          configFiles.forEach((f) => {
            next[f.name] = config.buildLoadingState();
          });
          return next;
        });

        const results = await Promise.allSettled(
          configFiles.map(async (file) => {
            try {
              const data = await config.fetchQuota(file, t);
              return { name: file.name, status: 'success' as const, data };
            } catch (err) {
              const message = err instanceof Error ? err.message : 'Unknown error';
              return { name: file.name, status: 'error' as const, error: message };
            }
          })
        );

        setter((prev: Record<string, unknown>) => {
          const next = { ...prev };
          results.forEach((result) => {
            if (result.status === 'fulfilled') {
              const r = result.value;
              if (r.status === 'success') {
                next[r.name] = (config.buildSuccessState as (data: unknown) => unknown)(r.data);
              } else {
                next[r.name] = config.buildErrorState(r.error);
              }
            }
          });
          return next;
        });
      };

      await Promise.all([
        fetchForConfig(antigravityFiles, ANTIGRAVITY_CONFIG, setAntigravityQuota),
        fetchForConfig(codexFiles, CODEX_CONFIG, setCodexQuota),
        fetchForConfig(geminiFiles, GEMINI_CLI_CONFIG, setGeminiCliQuota),
      ]);
    } finally {
      setQuotaRefreshing(false);
    }
  }, [quotaRefreshing, connectionStatus, t, setAntigravityQuota, setCodexQuota, setGeminiCliQuota]);

  const models = useModelsStore((state) => state.models);
  const modelsLoading = useModelsStore((state) => state.loading);
  const fetchModelsFromStore = useModelsStore((state) => state.fetchModels);

  const [stats, setStats] = useState<{
    apiKeys: number | null;
    authFiles: number | null;
  }>({
    apiKeys: null,
    authFiles: null,
  });

  const [providerStats, setProviderStats] = useState<ProviderStats>({
    gemini: null,
    codex: null,
    claude: null,
    openai: null,
  });

  const [loading, setLoading] = useState(true);

  const apiKeysCache = useRef<string[]>([]);

  useEffect(() => {
    apiKeysCache.current = [];
  }, [apiBase, config?.apiKeys]);

  const normalizeApiKeyList = (input: any): string[] => {
    if (!Array.isArray(input)) return [];
    const seen = new Set<string>();
    const keys: string[] = [];

    input.forEach((item) => {
      const value = typeof item === 'string' ? item : (item?.['api-key'] ?? item?.apiKey ?? '');
      const trimmed = String(value || '').trim();
      if (!trimmed || seen.has(trimmed)) return;
      seen.add(trimmed);
      keys.push(trimmed);
    });

    return keys;
  };

  const resolveApiKeysForModels = useCallback(async () => {
    if (apiKeysCache.current.length) {
      return apiKeysCache.current;
    }

    const configKeys = normalizeApiKeyList(config?.apiKeys);
    if (configKeys.length) {
      apiKeysCache.current = configKeys;
      return configKeys;
    }

    try {
      const list = await apiKeysApi.list();
      const normalized = normalizeApiKeyList(list);
      if (normalized.length) {
        apiKeysCache.current = normalized;
      }
      return normalized;
    } catch {
      return [];
    }
  }, [config?.apiKeys]);

  const fetchModels = useCallback(async () => {
    if (connectionStatus !== 'connected' || !apiBase) {
      return;
    }

    try {
      const apiKeys = await resolveApiKeysForModels();
      const primaryKey = apiKeys[0];
      await fetchModelsFromStore(apiBase, primaryKey);
    } catch {
      // Ignore model fetch errors on dashboard
    }
  }, [connectionStatus, apiBase, resolveApiKeysForModels, fetchModelsFromStore]);

  useEffect(() => {
    const fetchStats = async () => {
      setLoading(true);
      try {
        const [keysRes, filesRes, geminiRes, codexRes, claudeRes, openaiRes] =
          await Promise.allSettled([
            apiKeysApi.list(),
            authFilesApi.list(),
            providersApi.getGeminiKeys(),
            providersApi.getCodexConfigs(),
            providersApi.getClaudeConfigs(),
            providersApi.getOpenAIProviders(),
          ]);

        setStats({
          apiKeys: keysRes.status === 'fulfilled' ? keysRes.value.length : null,
          authFiles: filesRes.status === 'fulfilled' ? filesRes.value.files.length : null,
        });

        setProviderStats({
          gemini: geminiRes.status === 'fulfilled' ? geminiRes.value.length : null,
          codex: codexRes.status === 'fulfilled' ? codexRes.value.length : null,
          claude: claudeRes.status === 'fulfilled' ? claudeRes.value.length : null,
          openai: openaiRes.status === 'fulfilled' ? openaiRes.value.length : null,
        });
      } finally {
        setLoading(false);
      }
    };

    if (connectionStatus === 'connected') {
      fetchStats();
      fetchModels();
    } else {
      setLoading(false);
    }
  }, [connectionStatus, fetchModels]);

  // Calculate total provider keys only when all provider stats are available.
  const providerStatsReady =
    providerStats.gemini !== null &&
    providerStats.codex !== null &&
    providerStats.claude !== null &&
    providerStats.openai !== null;
  const hasProviderStats =
    providerStats.gemini !== null ||
    providerStats.codex !== null ||
    providerStats.claude !== null ||
    providerStats.openai !== null;
  const totalProviderKeys = providerStatsReady
    ? (providerStats.gemini ?? 0) +
      (providerStats.codex ?? 0) +
      (providerStats.claude ?? 0) +
      (providerStats.openai ?? 0)
    : 0;

  const quickStats: QuickStat[] = [
    {
      label: t('nav.api_keys'),
      value: stats.apiKeys ?? '-',
      icon: <IconKey size={24} />,
      path: '/api-keys',
      loading: loading && stats.apiKeys === null,
      sublabel: t('dashboard.management_keys'),
    },
    {
      label: t('nav.ai_providers'),
      value: loading ? '-' : providerStatsReady ? totalProviderKeys : '-',
      icon: <IconBot size={24} />,
      path: '/ai-providers',
      loading: loading,
      sublabel: hasProviderStats
        ? t('dashboard.provider_keys_detail', {
            gemini: providerStats.gemini ?? '-',
            codex: providerStats.codex ?? '-',
            claude: providerStats.claude ?? '-',
            openai: providerStats.openai ?? '-',
          })
        : undefined,
    },
    {
      label: t('nav.auth_files'),
      value: stats.authFiles ?? '-',
      icon: <IconFileText size={24} />,
      path: '/auth-files',
      loading: loading && stats.authFiles === null,
      sublabel: t('dashboard.oauth_credentials'),
    },
    {
      label: t('dashboard.available_models'),
      value: modelsLoading ? '-' : models.length,
      icon: <IconSatellite size={24} />,
      path: '/system',
      loading: modelsLoading,
      sublabel: t('dashboard.available_models_desc'),
    },
  ];

  return (
    <div className={styles.dashboard}>
      {/* 1. HERO SECTION */}
      <div className={styles.heroSection}>
        <div className={styles.heroHeader}>
          <div className={styles.heroContent}>
            <h1 className={styles.title}>{t('dashboard.title')}</h1>
            <p className={styles.subtitle}>{t('dashboard.subtitle')}</p>
          </div>
          <div
            className={`${styles.connectionBadge} ${
              connectionStatus === 'connected'
                ? styles.connected
                : connectionStatus === 'connecting'
                  ? styles.connecting
                  : styles.disconnected
            }`}
          >
            <span
              className={`${styles.statusDot} ${
                connectionStatus === 'connected'
                  ? styles.connected
                  : connectionStatus === 'connecting'
                    ? styles.connecting
                    : styles.disconnected
              }`}
            />
            {t(
              connectionStatus === 'connected'
                ? 'common.connected'
                : connectionStatus === 'connecting'
                  ? 'common.connecting'
                  : 'common.disconnected'
            )}
          </div>
        </div>

        <div className={styles.serverMeta}>
          <span className={styles.metaChip} title="API Endpoint">
            <span className={styles.metaLabel}>HOST:</span>
            {apiBase || '-'}
          </span>
          {serverVersion && (
            <span className={styles.metaChip} title="Server Version">
              <span className={styles.metaLabel}>VER:</span>v
              {serverVersion.trim().replace(/^[vV]+/, '')}
            </span>
          )}
          {serverBuildDate && (
            <span className={styles.metaChip} title="Build Date">
              <span className={styles.metaLabel}>BUILT:</span>
              {new Date(serverBuildDate).toLocaleDateString(i18n.language)}
            </span>
          )}
        </div>
      </div>

      {/* 2. STATS GRID */}
      <div className={styles.statsGrid}>
        {quickStats.map((stat) => (
          <Link key={stat.path} to={stat.path} className={styles.statCard}>
            <div className={styles.statHeader}>
              <div className={styles.statIcon}>{stat.icon}</div>
            </div>
            <div className={styles.statValueContainer}>
              {stat.loading ? (
                <span
                  className={`${styles.statValue} ${styles.skeleton}`}
                  style={{ width: '60px', height: '32px' }}
                />
              ) : (
                <span className={styles.statValue}>{stat.value}</span>
              )}
            </div>
            <span className={styles.statLabel}>{stat.label}</span>
            {stat.sublabel && !stat.loading && (
              <span className={styles.statSublabel}>{stat.sublabel}</span>
            )}
          </Link>
        ))}
      </div>

      {/* 3. QUOTA OVERVIEW SECTION */}
      <div className={styles.quotaSection}>
        <div className={styles.quotaHeader}>
          <h2>{t('dashboard.quota_overview')}</h2>
          <div className={styles.quotaActions}>
            <Button
              variant="secondary"
              size="sm"
              onClick={refreshAllQuota}
              disabled={quotaRefreshing || connectionStatus !== 'connected'}
              loading={quotaRefreshing}
              title="Refresh all quota data"
              className={styles.refreshButton}
            >
              {!quotaRefreshing && <IconRefreshCw size={14} />}
              {t('header.refresh_all')}
            </Button>
            <Link to="/quota" className={styles.editButton}>
              {t('dashboard.view_detailed_usage')} →
            </Link>
          </div>
        </div>

        {hasQuotaData ? (
          <div className={styles.quotaProviders}>
            {quotaSummary.map((provider) => (
              <div key={provider.name} className={styles.providerCard}>
                <div className={styles.providerTitle}>
                  <span className={styles.providerName}>{provider.name}</span>
                  <span className={styles.credentialCount}>
                    {t('dashboard.credentials_count', { count: provider.credentialCount })}
                  </span>
                </div>
                <div className={styles.quotaList}>
                  {provider.items.map((item) => (
                    <div key={item.id} className={styles.quotaItem}>
                      <div className={styles.quotaItemHeader}>
                        <span className={styles.quotaItemLabel}>{item.label}</span>
                        <span className={styles.quotaItemPercent}>{item.percent}%</span>
                      </div>
                      <div className={styles.quotaBar}>
                        <div
                          className={`${styles.quotaProgress} ${
                            item.percent > 60
                              ? styles.high
                              : item.percent > 20
                                ? styles.medium
                                : styles.low
                          }`}
                          style={{ width: `${item.percent}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className={styles.quotaEmpty}>
            <p>{t('dashboard.no_quota_data')}</p>
            <Link to="/quota" className={styles.quotaEmptyLink}>
              {t('dashboard.load_quota_hint')}
            </Link>
          </div>
        )}
      </div>

      {/* 4. CONFIGURATION SECTION */}
      {config && (
        <div className={styles.configSection}>
          <div className={styles.configHeader}>
            <h2>{t('dashboard.current_config')}</h2>
            <Link to="/settings" className={styles.editButton}>
              {t('dashboard.edit_settings')} →
            </Link>
          </div>

          <div className={styles.configGrid}>
            <div className={styles.configItem}>
              <span className={styles.configLabel}>{t('basic_settings.debug_enable')}</span>
              <div className={styles.configValueWrapper}>
                <span
                  className={`${styles.statusIndicator} ${config.debug ? styles.on : styles.off}`}
                />
                <span className={styles.configValue}>
                  {config.debug ? t('common.yes') : t('common.no')}
                </span>
              </div>
            </div>

            <div className={styles.configItem}>
              <span className={styles.configLabel}>
                {t('basic_settings.usage_statistics_enable')}
              </span>
              <div className={styles.configValueWrapper}>
                <span
                  className={`${styles.statusIndicator} ${config.usageStatisticsEnabled ? styles.on : styles.off}`}
                />
                <span className={styles.configValue}>
                  {config.usageStatisticsEnabled ? t('common.yes') : t('common.no')}
                </span>
              </div>
            </div>

            <div className={styles.configItem}>
              <span className={styles.configLabel}>
                {t('basic_settings.logging_to_file_enable')}
              </span>
              <div className={styles.configValueWrapper}>
                <span
                  className={`${styles.statusIndicator} ${config.loggingToFile ? styles.on : styles.off}`}
                />
                <span className={styles.configValue}>
                  {config.loggingToFile ? t('common.yes') : t('common.no')}
                </span>
              </div>
            </div>

            <div className={styles.configItem}>
              <span className={styles.configLabel}>{t('basic_settings.ws_auth_enable')}</span>
              <div className={styles.configValueWrapper}>
                <span
                  className={`${styles.statusIndicator} ${config.wsAuth ? styles.on : styles.off}`}
                />
                <span className={styles.configValue}>
                  {config.wsAuth ? t('common.yes') : t('common.no')}
                </span>
              </div>
            </div>

            <div className={styles.configItem}>
              <span className={styles.configLabel}>{t('basic_settings.retry_count_label')}</span>
              <span className={styles.configValue}>{config.requestRetry ?? 0}</span>
            </div>

            {config.proxyUrl && (
              <div className={`${styles.configItem} ${styles.configItemFull}`}>
                <span className={styles.configLabel}>{t('basic_settings.proxy_url_label')}</span>
                <span className={`${styles.configValue} ${styles.mono}`}>{config.proxyUrl}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
