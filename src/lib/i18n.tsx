import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export type Lang = 'ar' | 'en';

const STORAGE_KEY = 'iay.lang';

type Dict = Record<string, { ar: string; en: string }>;

/**
 * Every user-facing string lives here. Arabic is the default; the switch flips
 * both the text and the document direction (RTL/LTR) on the <html> element.
 */
const dict: Dict = {
  appName: { ar: 'ابن اليمن', en: 'Ibn Al Yemen' },
  appSuffix: { ar: 'الذكاء الاصطناعي للتحليل الفني', en: 'AI Market Analysis' },
  tagline: {
    ar: 'تحليل فني لصور الشارت من MT4 و MT5 و TradingView',
    en: 'Technical analysis for MT4, MT5 and TradingView charts',
  },
  language: { ar: 'اللغة', en: 'Language' },
  arabic: { ar: 'العربية', en: 'Arabic' },
  english: { ar: 'English', en: 'English' },

  signIn: { ar: 'تسجيل الدخول', en: 'Sign in' },
  signUp: { ar: 'إنشاء حساب', en: 'Create account' },
  signOut: { ar: 'تسجيل الخروج', en: 'Sign out' },
  email: { ar: 'البريد الإلكتروني', en: 'Email' },
  password: { ar: 'كلمة المرور', en: 'Password' },
  confirmPassword: { ar: 'تأكيد كلمة المرور', en: 'Confirm password' },
  displayName: { ar: 'الاسم (اختياري)', en: 'Display name (optional)' },
  country: { ar: 'بلد الإقامة', en: 'Country of residence' },
  countrySearch: { ar: 'ابحث عن بلدك', en: 'Search for your country' },
  account: { ar: 'الحساب', en: 'Account' },
  profile: { ar: 'الملف الشخصي', en: 'Profile' },
  history: { ar: 'السجل', en: 'History' },
  subscription: { ar: 'الاشتراك', en: 'Subscription' },
  subscribe: { ar: 'اشترك الآن', en: 'Subscribe' },
  admin: { ar: 'لوحة المالك', en: 'Owner dashboard' },

  home: { ar: 'الرئيسية', en: 'Home' },
  goldPrice: { ar: 'سعر الذهب اللحظي', en: 'Live gold price' },
  livePrice: { ar: 'السعر اللحظي', en: 'Live price' },
  providerTime: { ar: 'توقيت المزوّد', en: 'Provider time' },
  updatedAt: { ar: 'آخر تحديث', en: 'Updated' },
  staleData: { ar: 'بيانات متأخرة', en: 'Delayed data' },
  priceUnavailable: {
    ar: 'مزوّد الأسعار غير متاح حالياً. لن نعرض سعراً قديماً أو مُخترعاً.',
    en: 'The price provider is unavailable. No outdated or invented price is shown.',
  },
  retry: { ar: 'إعادة المحاولة', en: 'Retry' },
  instrument: { ar: 'الأداة', en: 'Instrument' },
  timeframe: { ar: 'الفريم الزمني', en: 'Timeframe' },
  upload: { ar: 'صورة الشارت', en: 'Chart screenshot' },
  uploadHint: {
    ar: 'اسحب الصورة هنا أو اضغط للاختيار — PNG أو JPG بحد أقصى 8 ميجابايت',
    en: 'Drop your screenshot here or tap to choose — PNG or JPG, max 8 MB',
  },
  changeImage: { ar: 'تغيير الصورة', en: 'Change image' },
  removeImage: { ar: 'إزالة', en: 'Remove' },
  analyze: { ar: 'تحليل الشارت', en: 'Analyze chart' },
  analyzing: { ar: 'جارٍ التحليل…', en: 'Analyzing…' },
  remainingTrial: { ar: 'التحليلات المجانية المتبقية', en: 'Free analyses remaining' },
  unlimited: { ar: 'وصول غير محدود', en: 'Unlimited access' },
  recentAnalyses: { ar: 'أحدث التحليلات', en: 'Recent analyses' },
  noAnalyses: { ar: 'لا توجد تحليلات بعد.', en: 'No analyses yet.' },
  viewAnalysis: { ar: 'عرض التحليل', en: 'View analysis' },
  newAnalysis: { ar: 'تحليل جديد', en: 'New analysis' },
  riskDisclaimer: {
    ar: 'هذا تحليل فني تعليمي وليس نصيحة استثمارية. التداول بالرافعة المالية عالي المخاطر وقد تخسر رأس مالك. أوامر وقف الخسارة قد تُنفّذ بسعر مختلف عند الفجوات أو الانزلاق السعري.',
    en: 'This is educational technical analysis, not investment advice. Leveraged trading is high risk and you can lose your capital. Stop losses may fill at a different price during gaps or slippage.',
  },
  trialExhausted: {
    ar: 'انتهت تحليلاتك المجانية. اشترك لمتابعة استخدام المنصة.',
    en: 'Your free analyses are used up. Subscribe to keep using the platform.',
  },
  notConfiguredAi: {
    ar: 'محرك التحليل غير مُهيّأ على هذا الخادم بعد. تواصل مع المالك.',
    en: 'The analysis engine is not configured on this server yet. Contact the owner.',
  },
  fridayGreeting: {
    ar: 'جمعة مباركة، نسأل الله لكم التوفيق والرزق الحلال.',
    en: 'Blessed Friday — may Allah grant you success and lawful provision.',
  },

  bias: { ar: 'الاتجاه', en: 'Bias' },
  bullish: { ar: 'صاعد', en: 'Bullish' },
  bearish: { ar: 'هابط', en: 'Bearish' },
  neutral: { ar: 'محايد', en: 'Neutral' },
  decision: { ar: 'القرار', en: 'Decision' },
  entry: { ar: 'الدخول', en: 'Entry' },
  entryZone: { ar: 'منطقة الدخول', en: 'Entry zone' },
  stopLoss: { ar: 'وقف الخسارة', en: 'Stop loss' },
  targets: { ar: 'الأهداف', en: 'Targets' },
  riskReward: { ar: 'المخاطرة/العائد', en: 'Risk/reward' },
  support: { ar: 'الدعوم', en: 'Support' },
  resistance: { ar: 'المقاومات', en: 'Resistance' },
  reasons: { ar: 'الأسباب الفنية', en: 'Technical reasons' },
  invalidation: { ar: 'إبطال التحليل', en: 'Invalidation' },
  warnings: { ar: 'تنبيهات', en: 'Warnings' },
  confidence: { ar: 'درجة الاقتناع', en: 'Confidence' },
  marketContext: { ar: 'سياق السوق', en: 'Market context' },
  generatedAt: { ar: 'وقت التحليل', en: 'Generated at' },
  dataSources: { ar: 'مصادر البيانات', en: 'Data sources' },
  chartPrice: { ar: 'سعر الشارت', en: 'Chart price' },
  unreadable: { ar: 'الصورة غير واضحة', en: 'Unreadable screenshot' },
  noTrade: { ar: 'لا صفقة', en: 'NO TRADE' },
  low: { ar: 'منخفضة', en: 'Low' },
  medium: { ar: 'متوسطة', en: 'Medium' },
  high: { ar: 'عالية', en: 'High' },
  priceConflict: { ar: 'تعارض بين الشارت والسعر اللحظي', en: 'Chart vs live price conflict' },
  sanitizationNotes: { ar: 'ملاحظات التحقق', en: 'Validation notes' },

  subscribeTitle: { ar: 'الاشتراك الشهري', en: 'Monthly subscription' },
  price: { ar: 'السعر', en: 'Price' },
  duration: { ar: 'المدة', en: 'Duration' },
  days: { ar: 'يوم', en: 'days' },
  network: { ar: 'الشبكة', en: 'Network' },
  wallet: { ar: 'عنوان المحفظة', en: 'Wallet address' },
  copyWallet: { ar: 'نسخ العنوان', en: 'Copy address' },
  copied: { ar: 'تم النسخ', en: 'Copied' },
  paymentWarning: {
    ar: 'أرسل USDT على شبكة TRON (TRC20) فقط. تحقق من العنوان قبل الإرسال. لا تشارك المفتاح الخاص أو العبارة السرية مع أي شخص أبداً.',
    en: 'Send USDT on the TRON (TRC20) network only. Verify the address before sending. Never share your private key or recovery phrase with anyone.',
  },
  txHash: { ar: 'رقم عملية التحويل (TXID)', en: 'Transaction hash (TXID)' },
  paymentScreenshot: { ar: 'صورة إشعار التحويل (اختياري)', en: 'Payment screenshot (optional)' },
  submitPayment: { ar: 'إرسال طلب الاشتراك', en: 'Submit subscription request' },
  paymentSubmitted: {
    ar: 'تم استلام طلبك. سيتم تفعيل الاشتراك بعد مراجعة المالك.',
    en: 'Request received. The owner will review it before activation.',
  },
  walletNotConfigured: {
    ar: 'لم يقم المالك بإعداد عنوان المحفظة بعد، لذلك تم تعطيل إرسال الطلبات.',
    en: 'The owner has not configured a wallet address yet, so submissions are disabled.',
  },
  pendingReview: { ar: 'بانتظار المراجعة', en: 'Pending review' },
  approved: { ar: 'مقبول', en: 'Approved' },
  rejected: { ar: 'مرفوض', en: 'Rejected' },
  activeUntil: { ar: 'ساري حتى', en: 'Active until' },
  notesLabel: { ar: 'ملاحظات', en: 'Notes' },
  myRequests: { ar: 'طلباتي', en: 'My requests' },
  noRequests: { ar: 'لا توجد طلبات.', en: 'No requests yet.' },

  save: { ar: 'حفظ', en: 'Save' },
  saving: { ar: 'جارٍ الحفظ…', en: 'Saving…' },
  cancel: { ar: 'إلغاء', en: 'Cancel' },
  close: { ar: 'إغلاق', en: 'Close' },
  back: { ar: 'رجوع', en: 'Back' },
  loading: { ar: 'جارٍ التحميل…', en: 'Loading…' },
  errorGeneric: { ar: 'حدث خطأ غير متوقع.', en: 'Something went wrong.' },
  offline: {
    ar: 'لا يوجد اتصال بالإنترنت. التحليل الفني يحتاج اتصالاً بالخادم.',
    en: 'You are offline. AI analysis requires a server connection.',
  },
  offlineBanner: { ar: 'أنت غير متصل — بعض الميزات غير متاحة.', en: 'You are offline — some features are unavailable.' },
  requiredField: { ar: 'هذا الحقل مطلوب.', en: 'This field is required.' },

  installApp: { ar: 'تثبيت التطبيق', en: 'Install app' },
  installHint: {
    ar: 'ثبّت التطبيق على شاشتك الرئيسية للوصول السريع.',
    en: 'Install the app on your home screen for quick access.',
  },
  installIos: {
    ar: 'على iPhone: افتح الموقع في Safari ثم اضغط زر المشاركة ← "إضافة إلى الشاشة الرئيسية".',
    en: 'On iPhone: open the site in Safari, tap Share, then "Add to Home Screen".',
  },
  installAndroid: {
    ar: 'على Android: من Chrome اضغط قائمة ⋮ ثم "تثبيت التطبيق" أو "إضافة إلى الشاشة الرئيسية".',
    en: 'On Android: in Chrome open the ⋮ menu, then "Install app" or "Add to Home screen".',
  },
  installed: { ar: 'التطبيق مثبّت على جهازك.', en: 'The app is installed on this device.' },
  pwaNote: {
    ar: 'نسخة الويب قابلة للتثبيت (PWA) ولا يوجد ملف APK أصلي.',
    en: 'The web app is installable (PWA). No native APK is provided.',
  },

  /* auth pages */
  createAccountTitle: { ar: 'أهلاً بك في ابن اليمن', en: 'Welcome to Ibn Al Yemen' },
  haveAccount: { ar: 'لديك حساب بالفعل؟', en: 'Already have an account?' },
  noAccount: { ar: 'ليس لديك حساب؟', en: 'No account yet?' },
  forgotPassword: { ar: 'نسيت كلمة المرور؟', en: 'Forgot your password?' },
  sendResetLink: { ar: 'إرسال رابط الاستعادة', en: 'Send reset link' },
  resetTitle: { ar: 'تعيين كلمة مرور جديدة', en: 'Set a new password' },
  newPassword: { ar: 'كلمة المرور الجديدة', en: 'New password' },
  verifyTitle: { ar: 'تأكيد البريد الإلكتروني', en: 'Email verification' },
  verifying: { ar: 'جارٍ التحقق…', en: 'Verifying…' },
  verifySuccess: { ar: 'تم تأكيد بريدك الإلكتروني.', en: 'Your email is verified.' },
  verifyFailed: { ar: 'رابط التحقق غير صالح أو منتهي.', en: 'This verification link is invalid or expired.' },
  resendVerification: { ar: 'إعادة إرسال رابط التحقق', en: 'Resend verification email' },
  emailNotVerified: {
    ar: 'بريدك الإلكتروني غير مؤكد. تحقق من صندوق الوارد.',
    en: 'Your email is not verified yet. Check your inbox.',
  },
  passwordRule: {
    ar: '٨ أحرف على الأقل مع حرف ورقم.',
    en: 'At least 8 characters including a letter and a number.',
  },
  countrySelfReported: {
    ar: 'البلد الذي تختاره مُصرَّح به منك وليس مُتحقَّقاً منه رسمياً.',
    en: 'Your country is self-reported, not independently verified.',
  },

  /* account */
  changeCountry: { ar: 'تغيير البلد', en: 'Change country' },
  countryLocked: { ar: 'لا يمكن تغيير البلد قبل', en: 'Country can change after' },
  emailVerifiedBadge: { ar: 'بريد مؤكد', en: 'Verified email' },
  emailUnverifiedBadge: { ar: 'بريد غير مؤكد', en: 'Email unverified' },
  accountStatus: { ar: 'حالة الحساب', en: 'Account status' },
  memberSince: { ar: 'عضو منذ', en: 'Member since' },
  usageTitle: { ar: 'الاستخدام', en: 'Usage' },
  totalRequests: { ar: 'إجمالي الطلبات', en: 'Total requests' },
  successful: { ar: 'ناجحة', en: 'Successful' },
  failed: { ar: 'فاشلة', en: 'Failed' },
  subscriptionHistory: { ar: 'سجل الاشتراكات', en: 'Subscription history' },

  /* admin */
  overview: { ar: 'نظرة عامة', en: 'Overview' },
  users: { ar: 'العملاء', en: 'Customers' },
  payments: { ar: 'المدفوعات', en: 'Payments' },
  settings: { ar: 'الإعدادات', en: 'Settings' },
  auditLog: { ar: 'سجل العمليات', en: 'Audit log' },
  searchUsers: { ar: 'ابحث بالبريد أو الاسم', en: 'Search by email or name' },
  totalCustomers: { ar: 'إجمالي العملاء', en: 'Customers' },
  activeSubscribers: { ar: 'مشتركون فعليون', en: 'Active subscribers' },
  pendingPayments: { ar: 'مدفوعات معلّقة', en: 'Pending payments' },
  suspendedAccounts: { ar: 'حسابات موقوفة', en: 'Suspended' },
  exemptions: { ar: 'إعفاءات مجانية', en: 'Free exemptions' },
  analysesToday: { ar: 'تحليلات اليوم', en: 'Analyses today' },
  analysesTotal: { ar: 'إجمالي التحليلات', en: 'Analyses total' },
  aiStatus: { ar: 'محرك الذكاء الاصطناعي', en: 'AI engine' },
  marketStatus: { ar: 'مزوّد الأسعار', en: 'Market provider' },
  mailStatus: { ar: 'البريد', en: 'Email' },
  configured: { ar: 'مُهيّأ', en: 'Configured' },
  notConfigured: { ar: 'غير مُهيّأ', en: 'Not configured' },
  approve: { ar: 'قبول', en: 'Approve' },
  reject: { ar: 'رفض', en: 'Reject' },
  viewScreenshot: { ar: 'عرض الإشعار', en: 'View screenshot' },
  grantAccess: { ar: 'منح وصول مجاني', en: 'Grant free access' },
  revokeAccess: { ar: 'إلغاء الوصول المجاني', en: 'Revoke free access' },
  suspend: { ar: 'إيقاف', en: 'Suspend' },
  reactivate: { ar: 'تنشيط', en: 'Reactivate' },
  suspendConfirm: { ar: 'سيتم إخراج العميل من الجلسة فوراً. المتابعة؟', en: 'This immediately ends the customer sessions. Continue?' },
  grantByEmail: { ar: 'منح وصول مجاني بالبريد', en: 'Grant free access by email' },
  grantByEmailHint: {
    ar: 'يجب أن يكون العميل مسجلاً أولاً.',
    en: 'The customer must be registered first.',
  },
  settingsSaved: { ar: 'تم حفظ الإعدادات.', en: 'Settings saved.' },
  trialCountLabel: { ar: 'عدد التحليلات المجانية', en: 'Free analyses per account' },
  priceCentsLabel: { ar: 'السعر (سنت)', en: 'Price (cents)' },
  durationDaysLabel: { ar: 'المدة (يوم)', en: 'Duration (days)' },
  networkLabel: { ar: 'شبكة الدفع', en: 'Payment network' },
  walletLabel: { ar: 'عنوان المحفظة (USDT TRC20)', en: 'Wallet address (USDT TRC20)' },
  paymentNotesLabel: { ar: 'ملاحظات الدفع للعملاء', en: 'Payment notes shown to customers' },
  noRows: { ar: 'لا توجد بيانات.', en: 'No data.' },
  accessDenied: { ar: 'هذه الصفحة للمالك فقط.', en: 'This page is for the owner only.' },
};

interface I18nValue {
  lang: Lang;
  dir: 'rtl' | 'ltr';
  setLang: (lang: Lang) => void;
  toggle: () => void;
  t: (key: keyof typeof dict) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

function initialLang(): Lang {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'ar' || stored === 'en') return stored;
  } catch {
    /* storage can be blocked; Arabic remains the default */
  }
  return 'ar';
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);
  const dir = lang === 'ar' ? 'rtl' : 'ltr';

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = dir;
  }, [lang, dir]);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* non-fatal */
    }
  }, []);

  const value = useMemo<I18nValue>(
    () => ({
      lang,
      dir,
      setLang,
      toggle: () => setLang(lang === 'ar' ? 'en' : 'ar'),
      t: (key) => dict[key]?.[lang] ?? String(key),
    }),
    [lang, dir, setLang],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used inside I18nProvider');
  return ctx;
}

/** Locale-aware helpers shared by every page. */
export function formatMoney(cents: number, currency: string, lang: Lang): string {
  const value = cents / 100;
  try {
    return new Intl.NumberFormat(lang === 'ar' ? 'ar-EG' : 'en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

export function formatPrice(price: number | null | undefined, lang: Lang, digits = 2): string {
  if (price === null || price === undefined || !Number.isFinite(price)) return '—';
  try {
    return new Intl.NumberFormat(lang === 'ar' ? 'ar-EG' : 'en-US', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(price);
  } catch {
    return price.toFixed(digits);
  }
}

export function formatDateTime(iso: string | null | undefined, lang: Lang): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat(lang === 'ar' ? 'ar-EG' : 'en-GB', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

export function formatDate(iso: string | null | undefined, lang: Lang): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat(lang === 'ar' ? 'ar-EG' : 'en-GB', { dateStyle: 'medium' }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}
