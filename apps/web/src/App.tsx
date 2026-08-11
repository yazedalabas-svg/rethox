import {
  Fragment,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  getCountries,
  getCountryCallingCode,
  parsePhoneNumberFromString,
  type CountryCode,
} from "libphonenumber-js";
import {
  Routes,
  Route,
  Link,
  NavLink,
  Navigate,
  Outlet,
  useNavigate,
  useLocation,
  useParams,
  useSearchParams,
} from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  Bookmark,
  BookOpen,
  Check,
  ChevronDown,
  ChevronLeft,
  Clock,
  Eye,
  EyeOff,
  FileText,
  Flag,
  Filter,
  Headphones,
  ImagePlus,
  Library,
  LogIn,
  Menu,
  Minus,
  MoreVertical,
  Maximize2,
  Minimize2,
  Moon,
  ArrowDown,
  RotateCcw,
  RotateCw,
  Volume2,
  Pause,
  Play,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  Sun,
  Trash2,
  ArrowUp,
  List,
  LockKeyhole,
  UserRound,
  X,
} from "lucide-react";
import {
  ApiError,
  accessTokenExpiresAt,
  api,
  apiUrl,
  refreshSession,
  setAuthSessionListener,
  setToken,
  type AuthSession,
} from "./api";
import type { Book, Chapter, ChapterComment, ChapterMeta, ContentReport, Progress, Review, Sentence, User } from "./types";
import { alignBoundaries, formatTime } from "./utils";

const fetchReviews = (bookId: string) =>
  api<{ reviews: Review[] }>(`/reviews/${bookId}`).then((r) => r.reviews);
const saveReview = (input: { bookId: string; rating: number; body: string; spoiler: boolean }) =>
  api<{ review: Review }>("/reviews", {
    method: "POST",
    body: JSON.stringify(input),
  }).then((r) => r.review);
const deleteReview = (bookId: string) => api(`/reviews/${bookId}`, { method: "DELETE" });
const fetchChapterComments = (chapterId: string) =>
  api<{ comments: ChapterComment[] }>(`/chapters/${chapterId}/comments`).then((r) => r.comments);
type ChapterContentResponse = {
  book: Book;
  chapter: Chapter;
  navigation?: {
    previous: { id: string; title: string; sentenceCount?: number; locked?: boolean } | null;
    next: { id: string; title: string; sentenceCount?: number; locked?: boolean } | null;
  };
  chapterList?: { id: string; title: string; position: number; locked?: boolean }[];
};

// A volume can contain thousands of sentence nodes.  Keep a request made from
// its table of contents so opening the reader can reuse it instead of fetching
// the same payload a second time.
const chapterContentRequests = new Map<string, Promise<ChapterContentResponse>>();
const getChapterContent = (chapterId: string) => {
  const cached = chapterContentRequests.get(chapterId);
  if (cached) return cached;
  const request = api<ChapterContentResponse>(`/chapters/${chapterId}/content`).catch((error) => {
    chapterContentRequests.delete(chapterId);
    throw error;
  });
  chapterContentRequests.set(chapterId, request);
  return request;
};
const saveChapterComment = ({
  chapterId,
  ...input
}: { chapterId: string; rating?: number; body: string; spoiler: boolean; parentId?: string }) =>
  api<{ comment: ChapterComment }>(`/chapters/${chapterId}/comments`, {
    method: "POST",
    body: JSON.stringify(input),
  }).then((r) => r.comment);
const deleteChapterComment = (chapterId: string, commentId: string) =>
  api(`/chapters/${chapterId}/comments/${commentId}`, { method: "DELETE" });
const saveReadingProgress = ({
  bookId,
  ...input
}: { bookId: string; chapterId: string; sentenceId?: string; wordId?: string; positionMs: number; percentage: number }) =>
  api(`/progress/${bookId}`, {
    method: "PUT",
    body: JSON.stringify({ ...input, clientUpdatedAt: new Date().toISOString() }),
  });
const setBookmark = (input: { bookId: string; chapterId: string; sentenceId: string; saved: boolean }) =>
  input.saved
    ? api("/bookmarks", {
        method: "POST",
        body: JSON.stringify({ bookId: input.bookId, chapterId: input.chapterId, sentenceId: input.sentenceId }),
      })
    : api(`/bookmarks/${encodeURIComponent(input.sentenceId)}`, { method: "DELETE" });
const currentReturnTo = () => `${window.location.pathname}${window.location.search}`;
const registerWithReturn = () => `/register?returnTo=${encodeURIComponent(currentReturnTo())}`;
const formatReadingDuration = (milliseconds: number) => {
  const minutes = Math.max(1, Math.round(milliseconds / 60_000));
  if (minutes < 60) return `${minutes} دقيقة`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} س ${rest} د` : `${hours} ساعة`;
};
const chapterReadingPercentage = (
  chapter: Pick<Chapter, "sentences"> | null,
  sentenceIndex: number,
  activeWordId = "",
  completed = false,
) => {
  if (!chapter?.sentences.length) return 0;
  if (completed) return 100;
  const safeSentenceIndex = Math.min(
    chapter.sentences.length - 1,
    Math.max(0, sentenceIndex),
  );
  const tokens = chapter.sentences[safeSentenceIndex]?.tokens || [];
  const activeTokenIndex = activeWordId
    ? tokens.findIndex((token) => token.id === activeWordId)
    : -1;
  const sentenceFraction = activeTokenIndex >= 0 && tokens.length
    ? activeTokenIndex / tokens.length
    : 0;
  return Math.min(
    100,
    Math.max(0, ((safeSentenceIndex + sentenceFraction) / chapter.sentences.length) * 100),
  );
};
const regionNames = new Intl.DisplayNames(["ar"], { type: "region" });
const CountryFlag = ({ country }: { country: CountryCode }) => {
  if (!country) return null;
  const codePoints = country
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .split("")
    .map((char) => 0x1f1e6 + char.charCodeAt(0) - 65);
  return <span aria-hidden="true">{String.fromCodePoint(...codePoints)}</span>;
};
const phoneCountries = getCountries()
  .map((country) => ({
    country,
    name: regionNames.of(country) || country,
    callingCode: getCountryCallingCode(country),
  }))
  .sort((left, right) => left.name.localeCompare(right.name, "ar"));
const formatDateTime = (iso: string) => {
  const diff = Date.now() - new Date(iso).getTime();
  const minute = Math.max(1, Math.floor(diff / 60000));
  if (minute < 60) return `منذ ${minute} د`;
  const hour = Math.floor(minute / 60);
  if (hour < 24) return `منذ ${hour} س`;
  const day = Math.floor(hour / 24);
  if (day < 7) return `منذ ${day} يوم`;
  return new Date(iso).toLocaleDateString("ar", { month: "short", day: "numeric" });
};
const weightedRating = (items: { rating: number }[]) => {
  const ratings = items.map((item) => item.rating).filter((rating) => rating > 0);
  if (!ratings.length) return 0;
  const prior = 3.8;
  const weight = 5;
  const total = ratings.reduce((sum, rating) => sum + rating, 0);
  return Math.round(((total + prior * weight) / (ratings.length + weight)) * 10) / 10;
};

type AuthValue = {
  user: User | null;
  ready: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string) => Promise<void>;
  googleLogin: (credential: string) => Promise<void>;
  startPhoneLogin: (phone: string) => Promise<void>;
  verifyPhoneLogin: (phone: string, token: string) => Promise<void>;
  updateProfile: (input: { name: string; avatarUrl?: string }) => Promise<void>;
  logout: () => Promise<void>;
};
type VoiceResult = {
  audioUrl: string;
  durationMs: number;
  boundaries: { text: string; startMs: number; endMs: number }[];
};
type PreparedNarrationSegment = {
  text: string;
  tokens: { id: string; text: string; sentenceIndex: number }[];
  result: VoiceResult;
  boundaryTokens: ({ id: string; sentenceIndex: number } | null)[];
};
type LastRead = {
  bookSlug: string;
  bookTitle: string;
  chapterId: string;
  chapterTitle: string;
  position: number;
  total: number;
  sentenceId?: string;
  wordId?: string;
};
const findActiveBoundary = (
  boundaries: { startMs: number; endMs: number }[],
  time: number,
) => {
  let low = 0;
  let high = boundaries.length - 1;
  let active = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const item = boundaries[middle];
    if (time < item.startMs) high = middle - 1;
    else {
      active = middle;
      low = middle + 1;
    }
  }
  return active;
};
type ReadingSettings = {
  fontSize: number;
  lineHeight: number;
  playbackSpeed: number;
  volume: number;
  autoNarration: boolean;
  notifications: boolean;
  privateHistory: boolean;
};
type ReadingHistoryItem = LastRead & { visitedAt: string; seconds: number };
const defaultReadingSettings: ReadingSettings = {
  fontSize: 32, lineHeight: 2.25, playbackSpeed: 1, volume: 1,
  autoNarration: false, notifications: true, privateHistory: true,
};
const readSettings = (): ReadingSettings => {
  try { return { ...defaultReadingSettings, ...JSON.parse(localStorage.getItem("rethox-reading-settings") || "{}") }; }
  catch { return defaultReadingSettings; }
};
const saveSettings = (settings: ReadingSettings) => {
  localStorage.setItem("rethox-reading-settings", JSON.stringify(settings));
  localStorage.setItem("rethox-playback-speed", String(settings.playbackSpeed));
  localStorage.setItem("rethox-volume", String(settings.volume));
};
const readHistory = (): ReadingHistoryItem[] => {
  try { return JSON.parse(localStorage.getItem("rethox-reading-history") || "[]"); }
  catch { return []; }
};

function SpoilerCurtain({ text }: { text: string }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <div className={`spoiler-curtain ${revealed ? "revealed" : ""}`}>
      {!revealed ? (
        <button className="spoiler-cover" type="button" onClick={() => setRevealed(true)}>
          <Eye /> <span>هذا التعليق يحتوي حرقًا — اضغط لإظهار الكلام</span>
        </button>
      ) : (
        <button className="spoiler-reveal" dir="auto" type="button" onClick={() => setRevealed(false)}>
          {text}
        </button>
      )}
    </div>
  );
}

function CommunityAvatar({ name, src }: { name: string; src?: string }) {
  return src ? (
    <img className="community-avatar" src={src} alt="" referrerPolicy="no-referrer" />
  ) : (
    <span className="community-avatar fallback" aria-hidden="true">{name.trim().slice(0, 1)}</span>
  );
}

function CharacterGallery({ coverUrl, rezero }: { coverUrl?: string; rezero: boolean }) {
  const [selected, setSelected] = useState<{ name: string; role: string; bio: string } | null>(null);
  const characters = rezero
    ? [
        { name: "سوبارو", role: "محور الحكاية", bio: "يواصل رحلته وسط اختبارات قاسية، متمسكًا بإنقاذ من حوله مهما كان الثمن." },
        { name: "إيميليا", role: "رفيقة الرحلة", bio: "حضور هادئ وقوة متزنة؛ تدفع المجموعة إلى التمسك بالأمل حين تضيق الخيارات." },
        { name: "ريم", role: "حليفة", bio: "شخصية وفية ذات إرادة صلبة، وتبقى ذكراها جزءًا مهمًا من دوافع الرحلة." },
        { name: "رام", role: "حليفة", bio: "صريحة وحادة الملاحظة، لكنها تحمي رفاقها بطريقتها الخاصة." },
        { name: "شاولاً", role: "حارسة البرج", bio: "شخصية غامضة ترتبط بأسرار البرج وتاريخ لا يتضح دفعة واحدة." },
      ]
    : [
        { name: "بطل الحكاية", role: "محور القصة", bio: "الشخصية التي نرى العالم من خلال رحلتها وقراراتها." },
        { name: "رفيق الرحلة", role: "حليف", bio: "صوت آخر يوازن البطل ويكشف جوانب جديدة من الحكاية." },
        { name: "حارس السر", role: "شخصية غامضة", bio: "يعرف أكثر مما يقول، وظهوره يغيّر اتجاه الأحداث." },
      ];
  return (
    <>
      <div className="character-gallery">
        {characters.map((character, index) => (
          <button type="button" key={character.name} onClick={() => setSelected(character)}>
            {coverUrl ? <img src={coverUrl} alt="" style={{ objectPosition: `${20 + (index % 3) * 30}% center` }} /> : <i>{character.name.slice(0, 1)}</i>}
            <span>{character.name}<small>{character.role}</small></span>
          </button>
        ))}
      </div>
      {selected && (
        <div className="character-modal" role="dialog" aria-modal="true" aria-labelledby="character-name" onClick={() => setSelected(null)}>
          <article onClick={(event) => event.stopPropagation()}>
            <button className="character-close" onClick={() => setSelected(null)} aria-label="إغلاق"><X /></button>
            {coverUrl && <img src={coverUrl} alt={`صورة ${selected.name}`} />}
            <span>{selected.role}</span>
            <h3 id="character-name">{selected.name}</h3>
            <p>{selected.bio}</p>
          </article>
        </div>
      )}
    </>
  );
}

function AuthPrompt({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  // Portal to <body>: ancestors with transforms (reveal animations) would
  // otherwise trap position:fixed and the overlay would not cover the page.
  return createPortal(
    <div className="auth-prompt-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="auth-prompt" onClick={(event) => event.stopPropagation()}>
        <button className="auth-prompt-close" onClick={onClose} aria-label="إغلاق"><X /></button>
        <h3>سجّل للمتابعة</h3>
        <p>رأيك محفوظ هنا — يحتاج فقط حسابًا لنشره.</p>
        <div className="auth-prompt-options">
          <Link className="btn primary" to="/login"><LogIn /> تسجيل الدخول</Link>
          <Link className="btn secondary" to="/register"><UserRound /> إنشاء حساب جديد</Link>
          <GoogleSignIn className="btn secondary" returnTo="/" />
        </div>
      </div>
    </div>,
    document.body,
  );
}
const AuthContext = createContext<AuthValue>(null!);
const useAuth = () => useContext(AuthContext);
const AUTH_STORAGE_KEY = "rethox-auth-session";
type PersistedAuthSession = AuthSession;
const readPersistedAuthSession = (): PersistedAuthSession | null => {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedAuthSession>;
    if (parsed.accessToken && parsed.user) return parsed as PersistedAuthSession;
  } catch {
    // Ignore malformed session storage and fall back to guest state.
  }
  return null;
};
const writePersistedAuthSession = (session: PersistedAuthSession | null) => {
  if (typeof window === "undefined") return;
  if (!session) {
    localStorage.removeItem(AUTH_STORAGE_KEY);
    return;
  }
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
};
function AuthProvider({ children }: { children: ReactNode }) {
  const initialSession = useMemo(readPersistedAuthSession, []);
  const [session, setSession] = useState<PersistedAuthSession | null>(initialSession);
  const [ready, setReady] = useState(false);
  const logoutInFlight = useRef<Promise<void> | null>(null);
  const applySession = useCallback((next: PersistedAuthSession | null) => {
    setToken(next?.accessToken ?? null);
    setSession(next);
    writePersistedAuthSession(next);
  }, []);

  useEffect(() => {
    setToken(initialSession?.accessToken ?? null);
    const removeSessionListener = setAuthSessionListener(applySession);
    const syncSessionAcrossTabs = (event: StorageEvent) => {
      if (event.key === AUTH_STORAGE_KEY) applySession(readPersistedAuthSession());
    };
    window.addEventListener("storage", syncSessionAcrossTabs);
    const restoreSession = async () => {
      try {
        await refreshSession();
      } catch {
        // Network/server outages keep the last local session. An explicit 401
        // is handled by refreshSession and is the only automatic sign-out.
      } finally {
        setReady(true);
      }
    };
    void restoreSession();
    return () => {
      removeSessionListener();
      window.removeEventListener("storage", syncSessionAcrossTabs);
    };
  }, [applySession, initialSession]);

  useEffect(() => {
    if (!session?.accessToken) return;
    let active = true;
    let timer = 0;
    const renew = async () => {
      try {
        await refreshSession();
      } catch (error) {
        if (active && !(error instanceof ApiError && error.status === 401)) {
          timer = window.setTimeout(renew, 30_000);
        }
      }
    };
    const expiry = accessTokenExpiresAt(session.accessToken);
    const delay = expiry
      ? Math.max(15_000, expiry - Date.now() - 60_000)
      : 8 * 60_000;
    timer = window.setTimeout(renew, delay);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [session?.accessToken]);

  const login = async (email: string, password: string) => {
    const r = await api<AuthSession>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    applySession(r);
  };
  const register = async (name: string, email: string, password: string) => {
    const r = await api<AuthSession>("/auth/register", {
      method: "POST",
      body: JSON.stringify({ name, email, password }),
    });
    applySession(r);
  };
  const googleLogin = async (credential: string) => {
    const r = await api<AuthSession>("/auth/google/id-token", {
      method: "POST",
      body: JSON.stringify({ credential, consent: true }),
    });
    applySession(r);
  };
  const startPhoneLogin = async (phone: string) => {
    await api("/auth/phone/start", {
      method: "POST",
      body: JSON.stringify({ phone }),
    });
  };
  const verifyPhoneLogin = async (phone: string, token: string) => {
    const r = await api<AuthSession>("/auth/phone/verify", {
      method: "POST",
      body: JSON.stringify({ phone, token }),
    });
    applySession(r);
  };
  const logout = async () => {
    if (logoutInFlight.current) return logoutInFlight.current;
    // Make logout immediate and idempotent in the interface. The server-side
    // revocation continues once, even if the button was clicked repeatedly.
    applySession(null);
    logoutInFlight.current = api<void>("/auth/logout", { method: "POST", keepalive: true }, false)
      .catch(() => undefined)
      .finally(() => { logoutInFlight.current = null; });
    return logoutInFlight.current;
  };
  const updateProfile = async (input: { name: string; avatarUrl?: string }) => {
    const r = await api<{ user: User }>("/auth/profile", {
      method: "PATCH",
      body: JSON.stringify(input),
    });
    setSession((current) => {
      if (!current) return current;
      const next = { ...current, user: r.user };
      writePersistedAuthSession(next);
      return next;
    });
  };
  return (
    <AuthContext.Provider value={{
      user: session?.user ?? null,
      ready,
      login,
      register,
      googleLogin,
      startPhoneLogin,
      verifyPhoneLogin,
      updateProfile,
      logout,
    }}>
      {children}
    </AuthContext.Provider>
  );
}
function ProtectedRoute({ admin = false }: { admin?: boolean }) {
  const { user, ready } = useAuth();
  if (!ready) return <Loading />;
  if (!user) return <Navigate to="/login" replace />;
  if (admin && user.role !== "ADMIN") return <Navigate to="/account" replace />;
  return <Outlet />;
}
type CartValue = {
  ids: string[];
  add: (id: string) => void;
  remove: (id: string) => void;
  clear: () => void;
};
const CartContext = createContext<CartValue>(null!);
const useCart = () => useContext(CartContext);
function CartProvider({ children }: { children: ReactNode }) {
  const [ids, setIds] = useState<string[]>(() =>
    JSON.parse(localStorage.getItem("rethox-cart") || "[]"),
  );
  useEffect(
    () => localStorage.setItem("rethox-cart", JSON.stringify(ids)),
    [ids],
  );
  return (
    <CartContext.Provider
      value={{
        ids,
        add: (id) => setIds((v) => (v.includes(id) ? v : [...v, id])),
        remove: (id) => setIds((v) => v.filter((x) => x !== id)),
        clear: () => setIds([]),
      }}
    >
      {children}
    </CartContext.Provider>
  );
}
function LockedChapterPrompt({
  book,
  chapter,
  onClose,
}: {
  book: Pick<Book, "id" | "title" | "priceMinor">;
  chapter: Pick<ChapterMeta, "id" | "title"> | null;
  onClose: () => void;
}) {
  const { add } = useCart();
  const nav = useNavigate();
  if (!chapter) return null;
  return createPortal(
    <div className="chapter-lock-overlay" role="dialog" aria-modal="true" aria-labelledby="chapter-lock-title" onClick={onClose}>
      <article className="chapter-lock-card" onClick={(event) => event.stopPropagation()}>
        <button className="chapter-lock-close" type="button" onClick={onClose} aria-label="إغلاق"><X /></button>
        <span className="chapter-lock-icon"><LockKeyhole /></span>
        <small>هذا الفصل ضمن النسخة الكاملة</small>
        <h2 id="chapter-lock-title">{chapter.title}</h2>
        <p>الفصل الأول متاح كعينة. افتح الرواية مرة واحدة لتصبح جميع فصولها متاحة في مكتبتك.</p>
        <button className="btn primary full" type="button" onClick={() => {
          add(book.id);
          onClose();
          nav("/cart");
        }}><ShoppingBag /> شراء الرواية · {book.priceMinor / 100} ر.س</button>
      </article>
    </div>,
    document.body,
  );
}
function ThemeProvider({ children }: { children: ReactNode }) {
  const [dark, setDark] = useState(
    () => localStorage.getItem("rethox-theme") === "dark",
  );
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    localStorage.setItem("rethox-theme", dark ? "dark" : "light");
  }, [dark]);
  const toggleTheme = () => {
    document.documentElement.classList.add("theme-changing");
    setDark((value) => !value);
    window.setTimeout(() => document.documentElement.classList.remove("theme-changing"), 360);
  };
  return (
    <>
      <button
        className="theme-fab"
        onClick={toggleTheme}
        aria-label={dark ? "تفعيل الوضع الفاتح" : "تفعيل الوضع الداكن"}
      >
        {dark ? <Sun size={18} /> : <Moon size={18} />}
      </button>
      {children}
    </>
  );
}

function RouteSeo() {
  const { pathname } = useLocation();
  useEffect(() => {
    const privateRoute = /^\/(?:login|register|account|cart|settings|admin|reader)(?:\/|$)/.test(pathname);
    const robots = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
    if (robots) robots.content = privateRoute
      ? "noindex,nofollow"
      : "index,follow,max-image-preview:large";
    const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (canonical && !privateRoute) canonical.href = `https://rethox.online${pathname || "/"}`;
    if (pathname === "/") document.title = "rethox — اقرأها. اسمعها. عشها.";
  }, [pathname]);
  return null;
}

function App() {
  useEffect(() => {
    document.documentElement.dataset.identity = "studio";
    localStorage.removeItem("rethox-identity");
  }, []);
  return (
    <ThemeProvider>
      <RouteSeo />
      <AuthProvider>
        <CartProvider>
          <Routes>
            <Route element={<Shell />}>
              <Route index element={<Home />} />
              <Route path="book/:slug/volume/:volumeId" element={<VolumeContentsPage />} />
              <Route path="book/:slug" element={<BookPage />} />
              <Route path="login" element={<AuthPage />} />
              <Route path="register" element={<AuthPage register />} />
              <Route path="cart" element={<CartPage />} />
              <Route path="payment-callback" element={<PaymentCallback />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route element={<ProtectedRoute />}>
                <Route path="account" element={<AccountPage />} />
              </Route>
              <Route element={<ProtectedRoute admin />}>
                <Route path="admin" element={<AdminPage />} />
              </Route>
            </Route>
            <Route path="reader/:chapterId" element={<ReaderPage />} />
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        </CartProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}
function Shell() {
  const { user } = useAuth(),
    { ids } = useCart();
  const [open, setOpen] = useState(false);
  return (
    <div className="app-shell">
      <header>
        <div className="wrap nav">
          <Link to="/" className="brand">
            <img className="brand-mark brand-mark-light" src="/rethox-mark.webp" alt="rethox logo" fetchPriority="high" />
            <img className="brand-mark brand-mark-dark" src="/rethox-mark-dark.webp" alt="rethox logo" fetchPriority="high" />
            <b>
              rethox<small>READ · LISTEN · LIVE</small>
            </b>
          </Link>
          <nav className={open ? "open" : ""}>
            <NavLink to="/">المكتبة</NavLink>
            <a href="/#features">كيف تعمل؟</a>
            <a href="/#new">الإصدارات</a>
            {user?.role === "ADMIN" && (
              <NavLink to="/admin">لوحة الإدارة</NavLink>
            )}
          </nav>
          <div className="nav-actions">
            <NavLink
              to="/settings"
              className="settings-link"
              aria-label="إعدادات القراءة والصوت"
              title="الإعدادات"
            >
              <Settings size={18} />
            </NavLink>
            {user ? (
              <Link to="/account" className="user-link">
                <UserRound size={17} />
                {user.name}
              </Link>
            ) : (
              <Link to="/login" className="user-link">
                <LogIn size={17} />
                دخول
              </Link>
            )}
            <Link to="/cart" className="bag" aria-label={`السلة ${ids.length}`}>
              <ShoppingBag size={18} />
              {ids.length > 0 && <b>{ids.length}</b>}
            </Link>
            <button
              className="menu"
              onClick={() => setOpen((v) => !v)}
              aria-label="القائمة"
            >
              {open ? <X /> : <Menu />}
            </button>
          </div>
        </div>
      </header>
      <main>
        <Outlet />
      </main>
      <footer>
        <div className="wrap footer">
          <div>
            <Link to="/" className="brand footer-brand">
              <img className="brand-mark brand-mark-light" src="/rethox-mark.webp" alt="rethox logo" loading="lazy" />
              <img className="brand-mark brand-mark-dark" src="/rethox-mark-dark.webp" alt="rethox logo" loading="lazy" />
              <b>rethox</b>
            </Link>
            <p>
              قصص تُقرأ بالأذن والعين. تجربة عربية خيالية للكتب الرقمية والصوت
              التفاعلي.
            </p>
          </div>
          <div>
            <b>استكشف</b>
            <Link to="/">المكتبة</Link>
            <a href="/#features">كيف تعمل؟</a>
            <Link to="/account">حسابي</Link>
            <Link to="/settings">الإعدادات</Link>
          </div>
          <div>
            <b>الخصوصية أولًا</b>
            <p>خيارات القراءة والصوت محفوظة على جهازك.</p>
          </div>
        </div>
      </footer>
    </div>
  );
}

function Home() {
  const [books, setBooks] = useState<Book[]>([]);
  const [lastRead, setLastRead] = useState<LastRead | null>(null);
  const [q, setQ] = useState("");
  const [genre, setGenre] = useState("الكل");
  useEffect(() => {
    api<{ books: Book[] }>("/books").then((r) => setBooks(r.books));
    const description = "rethox مكتبة عربية للروايات الرقمية والقراءة الصوتية التفاعلية، مع مزامنة النص وحفظ تقدم القراءة.";
    const descriptionMeta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    const ogTitle = document.querySelector<HTMLMetaElement>('meta[property="og:title"]');
    const ogDescription = document.querySelector<HTMLMetaElement>('meta[property="og:description"]');
    if (descriptionMeta) descriptionMeta.content = description;
    if (ogTitle) ogTitle.content = "rethox — اقرأها. اسمعها. عشها.";
    if (ogDescription) ogDescription.content = description;
    try {
      setLastRead(JSON.parse(localStorage.getItem("rethox-last-read") || "null"));
    } catch {
      setLastRead(null);
    }
  }, []);
  const filtered = books.filter(
    (b) =>
      (genre === "الكل" || b.genre === genre) &&
      `${b.title} ${b.author} ${b.tags.join(" ")}`.includes(q),
  );
  return (
    <>
      <section className="hero">
        <div className="wrap hero-grid">
          <div className="hero-copy">
            <span className="eyebrow">
              <Sparkles size={14} /> القراءة، بصوتٍ جديد
            </span>
            <h1>
              اقرأها.
              <br />
              <em>اسمعها.</em>
              <br />
              عِشها.
            </h1>
            <p>
              مكتبة عربية تجمع النص والصوت في مساحة واحدة. اضغط على أي كلمة
              لتسمعها، واترك القصة تتبع إيقاعك.
            </p>
            <div className="hero-actions">
              <a href="#new" className="btn primary">
                ابدأ القراءة <ArrowLeft size={17} />
              </a>
              <Link to="/book/city-of-mirrors" className="listen-link">
                <span>
                  <Play size={16} fill="currentColor" />
                </span>
                استمع إلى عينة
              </Link>
            </div>
            <div className="hero-metrics">
              <div>
                <b>+١٢</b>
                <small>عنوانًا خياليًا</small>
              </div>
              <div>
                <b>٪١٠٠</b>
                <small>واجهة عربية</small>
              </div>
              <div>
                <b>RTL</b>
                <small>قراءة طبيعية</small>
              </div>
            </div>
          </div>
          <div className="hero-visual">
            <div className="orbital one"></div>
            <div className="orbital two"></div>
            <div className="floating-book cover-indigo">
              <span>R·01</span>
              <h2>
                مدينة
                <br />
                المرايا
              </h2>
              <small>رواية من عالمٍ لا يعكس الحقيقة</small>
              <div className="wave">▂▅▇▃▆▂▅▇▅▃▆▂▇</div>
            </div>
            <div className="now-playing">
              <span>
                <Pause size={14} />
              </span>
              <div>
                <b>حين وصلت نور...</b>
                <small>الفصل الأول · 00:18</small>
              </div>
            </div>
          </div>
        </div>
      </section>
      <section className="features" id="features">
        <div className="wrap feature-row">
          <div>
            <Headphones />
            <b>سرد متزامن</b>
            <small>الكلمات تضيء مع الصوت</small>
          </div>
          <div>
            <BookOpen />
            <b>قراءة على مزاجك</b>
            <small>خط، ثيم، وسرعة قابلة للتخصيص</small>
          </div>
          <div>
            <Bookmark />
            <b>مكانك محفوظ</b>
            <small>ارجع للقصة من حيث توقفت</small>
          </div>
          <div>
            <Sparkles />
            <b>خلاصة ذكية</b>
            <small>فهم سريع للجمل الصعبة</small>
          </div>
        </div>
      </section>
      {lastRead && (
        <section className="continue-section wrap reveal-section">
          <div className="continue-copy">
            <span className="kicker">أكمل القراءة</span>
            <h2>{lastRead.bookTitle}</h2>
            <p>{lastRead.chapterTitle}</p>
            <div className="continue-progress">
              <span
                style={{
                  width: `${Math.max(2, (lastRead.position / lastRead.total) * 100)}%`,
                }}
              />
            </div>
          </div>
          <Link className="btn primary" to={`/reader/${lastRead.chapterId}`}>
            تابع من مكانك <ArrowLeft size={16} />
          </Link>
        </section>
      )}
      <section className="catalog wrap" id="new">
        <div className="section-title">
          <div>
            <span>المكتبة</span>
            <h2>قصص تنتظر صوتك</h2>
          </div>
          <p>كل الكتب والأسماء هنا خيالية، صنعت خصيصًا لتجربة rethox.</p>
        </div>
        <div className="catalog-tools">
          <div className="search">
            <Search size={16} />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="ابحث عن عنوان أو كاتب..."
              aria-label="البحث في الكتب"
            />
          </div>
          <div className="genres">
            <Filter size={15} />
            {["الكل", "فانتازيا", "خيال علمي", "أدب"].map((x) => (
              <button
                key={x}
                onClick={() => setGenre(x)}
                className={genre === x ? "active" : ""}
              >
                {x}
              </button>
            ))}
          </div>
        </div>
        <div className="book-grid">
          {filtered.map((b, i) => (
            <BookCard book={b} key={b.id} index={i} />
          ))}
        </div>
      </section>
      <section className="human-section">
        <div className="wrap human-grid">
          <div className="reader-preview">
            <span className="ribbon">تجربة تفاعلية</span>
            <p>
              لم يكن في الطريق أحد، ومع ذلك سمعت <mark>خطوات</mark> تمشي على مهل
              خلفها.
            </p>
            <div className="mini-player">
              <Play size={16} />
              <span></span>
              <small>00:13 / 00:24</small>
            </div>
          </div>
          <div>
            <span className="kicker">الكلمة لها صوت</span>
            <h2>
              القصة تمشي
              <br />
              على إيقاعك أنت.
            </h2>
            <p>
              اضغط على كلمة، اسمع نطقها، عدّل السرعة أو اطلب خلاصة. صممنا القارئ
              ليكون هادئًا في الخلفية وحاضرًا عندما تحتاجه.
            </p>
            <Link to="/book/city-of-mirrors" className="text-link">
              جرّب القارئ الآن <ArrowLeft size={15} />
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
function BookCard({ book, index }: { book: Book; index: number }) {
  return (
    <article className="book-card">
      <div className="book-badges">
        <span>صوت متاح</span>
        {index === 0 && <span className="new">جديد</span>}
      </div>
      <Link
        to={`/book/${book.slug}`}
        className={`cover cover-${book.coverTheme} ${book.coverUrl ? "image-cover" : ""}`}
        style={
          book.coverUrl ? { backgroundImage: `url(${book.coverUrl})` } : undefined
        }
      >
        <span>R·0{index + 1}</span>
        <h3>{book.title}</h3>
        <small>{book.author}</small>
        <i>{book.genre}</i>
      </Link>
      <div className="book-meta">
        <div>
          <h3>
            <Link to={`/book/${book.slug}`}>{book.title}</Link>
          </h3>
          <p>{book.author}</p>
        </div>
        <span className="rating">{book.rating ? `★ ${book.rating}` : "لم يُقيّم بعد"}</span>
      </div>
      <div className="tags">
        {book.tags.slice(0, 2).map((t) => (
          <span key={t}>{t}</span>
        ))}
      </div>
      <div className="book-bottom">
        <b>
          {book.priceMinor / 100} <small>ر.س</small>
        </b>
        <Link to={`/book/${book.slug}`} aria-label={`تفاصيل ${book.title}`}>
          <ChevronLeft />
        </Link>
      </div>
    </article>
  );
}

function BookPage() {
  const { slug } = useParams();
  const nav = useNavigate();
  const [bookParams] = useSearchParams();
  const requestedLockedChapter = bookParams.get("locked");
  const [book, setBook] = useState<Book | null>(null);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [reviewAverage, setReviewAverage] = useState(0);
  const [reviewRating, setReviewRating] = useState(5);
  const [reviewFilter, setReviewFilter] = useState(0);
  const [reviewBody, setReviewBody] = useState("");
  const [reviewSpoiler, setReviewSpoiler] = useState(false);
  const [reviewMessage, setReviewMessage] = useState("");
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewMenuId, setReviewMenuId] = useState<string | null>(null);
  const [showAuthPrompt, setShowAuthPrompt] = useState(false);
  const [lockedChapter, setLockedChapter] = useState<ChapterMeta | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [readingLater, setReadingLater] = useState(false);
  const [ownsBook, setOwnsBook] = useState(false);
  const { user, ready } = useAuth();
  const { add, remove, ids } = useCart();
  useEffect(() => {
    if (!ready) return;
    api<{ book: Book }>(`/books/${slug}`).then((r) => setBook(r.book));
  }, [slug, ready]);
  useEffect(() => {
    if (!book || !requestedLockedChapter) return;
    const target = book.chapters?.find((item) => item.id === requestedLockedChapter && item.locked);
    if (target) setLockedChapter(target);
  }, [book?.id, requestedLockedChapter]);
  useEffect(() => {
    if (!book) return;
    fetchReviews(book.id).then((items) => {
      setReviews(items);
      setReviewAverage(weightedRating(items));
    }).catch(() => setReviews([]));
  }, [book?.id]);
  useEffect(() => {
    if (!book) return;
    document.title = `${book.title} — rethox`;
    const description = book.synopsis.slice(0, 155);
    const descriptionMeta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    const ogTitle = document.querySelector<HTMLMetaElement>('meta[property="og:title"]');
    const ogDescription = document.querySelector<HTMLMetaElement>('meta[property="og:description"]');
    if (descriptionMeta) descriptionMeta.content = description;
    if (ogTitle) ogTitle.content = `${book.title} — rethox`;
    if (ogDescription) ogDescription.content = description;
  }, [book?.id]);
  useEffect(() => {
    if (!book || !user) {
      setProgress(null);
      setReadingLater(false);
      setOwnsBook(false);
      return;
    }
    Promise.all([
      api<{ progress: Progress | null }>(`/progress/${book.id}`),
      api<{ bookIds: string[] }>("/reading-list"),
      api<{ bookIds: string[] }>("/entitlements"),
    ]).then(([savedProgress, list, entitlements]) => {
      setProgress(savedProgress.progress);
      setReadingLater(list.bookIds.includes(book.id));
      const purchased = entitlements.bookIds.includes(book.id);
      setOwnsBook(purchased);
      if (purchased && ids.includes(book.id)) remove(book.id);
    }).catch(() => {});
  }, [book?.id, user?.id]);
  const toggleReadingLater = async () => {
    if (!book) return;
    if (!user) return nav(registerWithReturn());
    if (readingLater) await api(`/reading-list/${book.id}`, { method: "DELETE" });
    else await api(`/reading-list/${book.id}`, { method: "POST" });
    setReadingLater((value) => !value);
  };
  const submitReview = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!book || reviewBusy) return;
    if (!user) {
      nav(registerWithReturn());
      return;
    }
    const previousReviews = reviews;
    const previousReview = reviews.find((item) => item.user.id === user.id);
    const optimisticReview: Review = {
      id: previousReview?.id || `pending-${Date.now()}`,
      bookId: book.id,
      rating: reviewRating,
      body: reviewBody.trim(),
      spoiler: reviewSpoiler,
      createdAt: previousReview?.createdAt || new Date().toISOString(),
      user: { id: user.id, name: user.name, avatarUrl: user.avatarUrl },
    };
    const optimisticReviews = [optimisticReview, ...reviews.filter((item) => item.user.id !== user.id)];
    setReviews(optimisticReviews);
    setReviewAverage(weightedRating(optimisticReviews));
    setReviewBody("");
    setReviewSpoiler(false);
    setReviewMessage("ظهر تقييمك، جارٍ تثبيته...");
    setReviewBusy(true);
    try {
      const review = await saveReview({
        bookId: book.id,
        rating: reviewRating,
        body: optimisticReview.body,
        spoiler: optimisticReview.spoiler,
      });
      setReviews((current) => {
        const next = [review, ...current.filter((item) => item.id !== optimisticReview.id && item.user.id !== user.id)];
        setReviewAverage(weightedRating(next));
        return next;
      });
      setReviewMessage("تم نشر تقييمك");
    } catch (error) {
      setReviews(previousReviews);
      setReviewAverage(weightedRating(previousReviews));
      setReviewBody(optimisticReview.body);
      setReviewSpoiler(optimisticReview.spoiler);
      setReviewMessage((error as Error).message);
    } finally {
      setReviewBusy(false);
    }
  };
  const removeReview = async (target: Review) => {
    if (!book || !user || target.user.id !== user.id) return;
    const previousReviews = reviews;
    const next = reviews.filter((review) => review.id !== target.id);
    setReviewMenuId(null);
    setReviews(next);
    setReviewAverage(weightedRating(next));
    setReviewMessage("تم حذف تقييمك");
    try {
      await deleteReview(book.id);
    } catch (error) {
      setReviews(previousReviews);
      setReviewAverage(weightedRating(previousReviews));
      setReviewMessage((error as Error).message);
    }
  };
  if (!book) return <Loading />;
  const contentUnitLabel = book.contentUnitLabel || "فصل";
  const contentUnitLabelPlural = book.contentUnitLabelPlural || "فصول";
  const sample = book.chapters?.find((c) => c.isSample);
  const filteredReviews = reviewFilter
    ? reviews.filter((review) => review.rating === reviewFilter)
    : reviews;
  let completedBookChapters: string[] = [];
  try {
    completedBookChapters = JSON.parse(localStorage.getItem("rethox-completed-chapters") || "[]");
  } catch {}
  const chapterStatus = (chapter: ChapterMeta) => {
    if (completedBookChapters.includes(chapter.id)) return "";
    const savedIndex = Number(localStorage.getItem(`rethox-sentence-${chapter.id}`) || 0);
    return savedIndex > 0 ? "متوقف هنا" : "جديد";
  };
  const chapterState = (chapter: ChapterMeta) => {
    if (completedBookChapters.includes(chapter.id)) return "completed";
    return Number(localStorage.getItem(`rethox-sentence-${chapter.id}`) || 0) > 0
      ? "in-progress"
      : "not-started";
  };
  const totalReadingMs = (book.chapters || []).reduce(
    (total, chapter) => total + Math.max(0, chapter.durationMs || 0),
    0,
  ) || Math.max(1, book.pageCount || 1) * 90_000;
  const remainingReadingMs = totalReadingMs * (1 - Math.min(100, progress?.percentage || 0) / 100);
  return (
    <section className="book-page">
      <div className="wrap book-detail">
        <div
          className={`detail-cover cover-${book.coverTheme} ${book.coverUrl ? "image-cover" : ""}`}
          style={
            book.coverUrl
              ? { backgroundImage: `url(${book.coverUrl})` }
              : undefined
          }
          role="img"
          aria-label={`غلاف ${book.title}`}
        >
          <span>RETHOX ORIGINAL</span>
          <h1>{book.title}</h1>
          <small>{book.author}</small>
          <div className="cover-sound">▂▅▇▃▆▂▅▇</div>
        </div>
        <div className="detail-info">
          <div className="crumb">
            <Link to="/">المكتبة</Link>
            <ChevronLeft size={13} />
            {book.genre}
          </div>
          <span className="kicker">{book.tags.join(" · ")}</span>
          <h1>{book.title}</h1>
          <h3>{book.author}</h3>
          <div className="book-stats">
            <span>{"\u2605"} تقييم العمل {reviews.length ? reviewAverage.toFixed(1) : "لم يُقيّم بعد"}</span>
            <span>آراء القراء {reviews.length}</span>
            <span>
              <Clock size={14} />
              {Math.max(1, book.chapters?.length || 1)} {contentUnitLabel}
            </span>
            <span>
              <Headphones size={14} />
              صوت تفاعلي
            </span>
            {book.pageCount && (
              <span>
                <FileText size={14} />
                {book.pageCount} صفحة
              </span>
            )}
            <span>
              <Clock size={14} />
              نحو {formatReadingDuration(totalReadingMs)}
            </span>
          </div>
          <p>{book.synopsis}</p>
          <div className="book-progress-card">
            <div>
              <span>تقدمك في الرواية</span>
              <b>{Math.round(progress?.percentage || 0)}%</b>
            </div>
            <i><span style={{ width: `${Math.min(100, progress?.percentage || 0)}%` }} /></i>
            <small>
              {progress
                ? `متبقٍ تقريبًا ${formatReadingDuration(remainingReadingMs)}`
                : `وقت القراءة المتوقع ${formatReadingDuration(totalReadingMs)}`}
            </small>
          </div>
          <div className="detail-actions">
            <button
              className="btn primary"
              disabled={ownsBook}
              onClick={() => !ownsBook && add(book.id)}
            >
              {ownsBook ? (
                <>
                  <Check size={17} />
                  تم الشراء
                </>
              ) : ids.includes(book.id) ? (
                <>
                  <Check size={17} />
                  في السلة
                </>
              ) : (
                <>
                  <ShoppingBag size={17} />
                  أضف للسلة · {book.priceMinor / 100} ر.س
                </>
              )}
            </button>
            {sample && (
              <Link
                className="btn secondary"
                to={sample.sections?.length ? `/book/${book.slug}/volume/${sample.id}` : `/reader/${sample.id}`}
                state={sample.sections?.length ? { book, chapter: sample } : undefined}
              >
                <Play size={16} />
                استمع للعينة
              </Link>
            )}
            <button className={`btn secondary ${readingLater ? "saved" : ""}`} onClick={toggleReadingLater}>
              <Bookmark size={16} fill={readingLater ? "currentColor" : "none"} />
              {readingLater ? "محفوظة للقراءة لاحقًا" : "أضف للقراءة لاحقًا"}
            </button>
            {book.pdfUrl && (
              <a
                className="btn secondary"
                href={book.pdfUrl}
                target="_blank"
                rel="noreferrer"
              >
                <FileText size={16} />
                فتح نسخة PDF
              </a>
            )}
          </div>
          {!!book.chapters?.length && (
            <div className="chapter-directory">
              <div className="chapter-directory-head">
                <div>
                  <span className="kicker">{contentUnitLabelPlural} الرواية</span>
                  <h2>ابدأ من حيث تريد</h2>
                </div>
                <span>{book.chapters.length} {contentUnitLabelPlural}</span>
              </div>
              <div className="chapter-directory-list">
                {book.chapters.map((chapter) => {
                  const content = <>
                    <span>{String(chapter.position).padStart(2, "0")}</span>
                    <b>
                      {chapter.title}
                      {chapter.locked ? <small>يفتح بعد الشراء</small> : chapterStatus(chapter) && <small>{chapterStatus(chapter)}</small>}
                    </b>
                    <em className={chapter.rating ? "has-rating" : ""}>
                      ★ {chapter.rating ? chapter.rating.toFixed(1) : "لم يُقيّم"}
                    </em>
                    {chapter.locked ? <LockKeyhole size={15} /> : <ChevronLeft size={16} />}
                  </>;
                  return chapter.locked ? (
                    <button className="chapter-row locked" type="button" key={chapter.id} onClick={() => setLockedChapter(chapter)}>
                      {content}
                    </button>
                  ) : (
                    <Link
                      className={`chapter-row ${chapterState(chapter)}`}
                      key={chapter.id}
                      to={chapter.sections?.length ? `/book/${book.slug}/volume/${chapter.id}` : `/reader/${chapter.id}`}
                      state={chapter.sections?.length ? { book, chapter } : undefined}
                    >
                      {content}
                    </Link>
                  );
                })}
              </div>
            </div>
          )}
          {book.priceMinor > 0 && (
            <div className="detail-note">
              <LockKeyhole />
              {contentUnitLabel === "فصل" ? "الفصل الأول عينة مجانية، وبقية الفصول تفتح بعد الشراء." : `المجلد الأول عينة مجانية، وبقية ${contentUnitLabelPlural} تفتح بعد الشراء.`}
            </div>
          )}
        </div>
      </div>
      <div className="wrap book-extras reveal-section book-community-only">
        <article className="spoiler-review community-card">
          <h2>آراء القراء</h2>
          <form onSubmit={submitReview}>
            <div className="rating-picker">
              {[1, 2, 3, 4, 5].map((star) => (
                <button
                  type="button"
                  key={star}
                  className={reviewRating >= star ? "active" : ""}
                  onClick={() => setReviewRating(star)}
                  aria-label={`${star} نجوم`}
                >{reviewRating >= star ? "★" : "☆"}</button>
              ))}
            </div>
            <textarea
              dir="auto"
              value={reviewBody}
              onChange={(event) => setReviewBody(event.target.value)}
              maxLength={1200}
              placeholder="اكتب تعليقك إذا حبيت — التقييم وحده يكفي."
            />
            <label className="spoiler-toggle">
              <input
                type="checkbox"
                checked={reviewSpoiler}
                onChange={(event) => setReviewSpoiler(event.target.checked)}
              /> يحتوي حرقًا
            </label>
            <button className="btn primary" disabled={reviewBusy}>{reviewBusy ? "جارٍ التثبيت..." : "نشر التقييم"}</button>
            {reviewMessage && <small aria-live="polite">{reviewMessage}</small>}
          </form>
          <AuthPrompt open={showAuthPrompt} onClose={() => setShowAuthPrompt(false)} />
          {!!reviews.length && (
            <div className="rating-filter" aria-label="تصفية التقييمات">
              <button type="button" className={!reviewFilter ? "active" : ""} onClick={() => setReviewFilter(0)}>الكل</button>
              {[5, 4, 3, 2, 1].map((star) => (
                <button type="button" key={star} className={reviewFilter === star ? "active" : ""} onClick={() => setReviewFilter(star)}>
                  {star} ★
                </button>
              ))}
            </div>
          )}
          <div className="community-list">
            {filteredReviews.slice(0, 4).map((review) => (
              <div key={review.id}>
                <header>
                  <div className="community-author">
                    <CommunityAvatar name={review.user.name} src={review.user.avatarUrl} />
                    <div className="community-author-copy">
                      <b dir="auto">{review.user.name}</b>
                      <small><time dateTime={review.createdAt}>{formatDateTime(review.createdAt)}</time></small>
                    </div>
                  </div>
                  <div className="review-card-tools">
                    <span className="rating-stars">{"★".repeat(review.rating)}{"☆".repeat(5 - review.rating)}</span>
                    {user?.id === review.user.id && (
                      <div className="review-menu-wrap">
                        <button
                          className="review-menu-trigger"
                          type="button"
                          aria-label="خيارات التقييم"
                          aria-expanded={reviewMenuId === review.id}
                          onClick={() => setReviewMenuId((current) => current === review.id ? null : review.id)}
                        >
                          <MoreVertical size={17} />
                        </button>
                        {reviewMenuId === review.id && (
                          <div className="review-menu" role="menu">
                            <button type="button" role="menuitem" onClick={() => void removeReview(review)}>
                              <Trash2 size={14} /> حذف التقييم
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </header>
                {review.body && (review.spoiler ? <SpoilerCurtain text={review.body} /> : <p dir="auto">{review.body}</p>)}
              </div>
            ))}
          </div>
        </article>
      </div>
      <LockedChapterPrompt book={book} chapter={lockedChapter} onClose={() => setLockedChapter(null)} />
    </section>
  );
}

function VolumeContentsPage() {
  const { slug, volumeId } = useParams();
  const nav = useNavigate();
  const location = useLocation();
  const routeState = location.state as { book?: Book; chapter?: ChapterMeta } | null;
  const routeBook = routeState?.book;
  const routeChapter = routeState?.chapter;
  const initialBook = routeBook && routeBook.slug === slug ? routeBook : null;
  const initialChapter = routeChapter && routeChapter.id === volumeId
    ? routeChapter
    : initialBook?.chapters?.find((item) => item.id === volumeId) || null;
  const [book, setBook] = useState<Book | null>(initialBook);
  const [chapter, setChapter] = useState<ChapterMeta | null>(initialChapter);
  const [resolvedSections, setResolvedSections] = useState<NonNullable<ChapterMeta["sections"]>>([]);
  useEffect(() => {
    if (book && chapter?.id === volumeId) return;
    if (!slug || !volumeId) {
      nav("/", { replace: true });
      return;
    }
    let active = true;
    api<{ book: Book }>(`/books/${slug}`)
      .then((result) => {
        const selectedChapter = result.book.chapters?.find((item) => item.id === volumeId);
        if (!active || !selectedChapter) {
          if (active) nav(`/book/${slug}`, { replace: true });
          return;
        }
        setBook(result.book);
        setChapter(selectedChapter);
      })
      .catch(() => {
        if (active) nav(`/book/${slug}`, { replace: true });
      });
    return () => { active = false; };
  }, [book, chapter, nav, slug, volumeId]);
  useEffect(() => {
    if (!chapter) return;
    const prefetch = () => { void getChapterContent(chapter.id).catch(() => {}); };
    const idleWindow = window as Window & { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number; cancelIdleCallback?: (handle: number) => void };
    if (idleWindow.requestIdleCallback) {
      const handle = idleWindow.requestIdleCallback(prefetch, { timeout: 800 });
      return () => idleWindow.cancelIdleCallback?.(handle);
    }
    const timer = window.setTimeout(prefetch, 250);
    return () => window.clearTimeout(timer);
  }, [chapter?.id]);
  useEffect(() => {
    setResolvedSections([]);
    if (!chapter || chapter.sections?.length) return;
    let active = true;
    // Some older cached book payloads only contain the volume metadata.  In
    // that case, restore the in-volume table of contents from the chapter
    // response instead of replacing it with a single “start” entry.
    void getChapterContent(chapter.id)
      .then((result) => {
        if (active) setResolvedSections(result.chapter.sections || []);
      })
      .catch(() => {});
    return () => { active = false; };
  }, [chapter?.id, chapter?.sections?.length]);
  if (!book || !chapter) return <Loading />;
  const sections = chapter.sections?.length
    ? chapter.sections
    : resolvedSections.length
      ? resolvedSections
      : [{ id: `${chapter.id}-start`, title: "بداية المجلد", sentenceId: "", position: 1 }];
  const goToSection = (sentenceId: string) => {
    const query = sentenceId ? `?section=${encodeURIComponent(sentenceId)}` : "";
    nav(`/reader/${chapter.id}${query}`);
  };
  return (
    <section className="volume-contents-page">
      <div className="wrap volume-contents-wrap">
        <nav className="crumb" aria-label="مسار التنقل">
          <Link to={`/book/${book.slug}`}>الرواية</Link>
          <ChevronLeft size={14} />
          <span>{chapter.title}</span>
        </nav>
        <header className="volume-contents-head">
          <span className="kicker">فهرس المجلد</span>
          <h1>{chapter.title}</h1>
          <p>اختر مقطعًا للانتقال إليه مباشرة، أو ابدأ القراءة من البداية.</p>
          <button className="btn primary" type="button" onClick={() => goToSection(sections[0]?.sentenceId || "")}>
            <Play size={17} /> ابدأ من البداية
          </button>
        </header>
        <ol className="volume-section-list" aria-label={`أقسام ${chapter.title}`}>
          {sections.map((section) => (
            <li key={section.id}>
              <button type="button" onClick={() => goToSection(section.sentenceId)}>
                <i>{String(section.position).padStart(2, "0")}</i>
                <span>{section.title}</span>
                <ChevronLeft size={18} />
              </button>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function GoogleSignIn({ returnTo, className = "" }: { returnTo: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const continueWithGoogle = async () => {
    if (!accepted || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ authorizationUrl: string }>("/auth/google/consent", {
        method: "POST",
        body: JSON.stringify({ accepted: true, returnTo }),
      });
      window.location.assign(result.authorizationUrl);
    } catch (requestError) {
      setError((requestError as Error).message);
      setBusy(false);
    }
  };
  return (
    <>
      <button type="button" className={`google-oauth-button ${className}`} onClick={() => setOpen(true)}>
        <span className="google-mark" aria-hidden="true">G</span>
        <span>المتابعة باستخدام Google</span>
      </button>
      {open && createPortal(
        <div className="google-consent-overlay" role="dialog" aria-modal="true" aria-labelledby="google-consent-title" onClick={() => !busy && setOpen(false)}>
          <section className="google-consent-card" onClick={(event) => event.stopPropagation()}>
            <button type="button" className="auth-prompt-close" aria-label="إغلاق" disabled={busy} onClick={() => setOpen(false)}><X /></button>
            <span className="google-consent-logo" aria-hidden="true">G</span>
            <h2 id="google-consent-title">تأكيد المتابعة بحساب Google</h2>
            <p>بعد موافقتك ستنتقل إلى Google لاختيار الحساب ومراجعة الأذونات. لن ينشئ rethox حسابًا محليًا إلا بعد أن تتحقق Google من وجود الحساب والبريد الإلكتروني.</p>
            <label className="google-consent-check">
              <input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} />
              <span>أوافق على إنشاء حساب rethox جديد أو ربط حسابي الحالي بحساب Google الذي سأختاره.</span>
            </label>
            {error && <p className="auth-error">{error}</p>}
            <div className="google-consent-actions">
              <button type="button" className="btn secondary" disabled={busy} onClick={() => setOpen(false)}>إلغاء</button>
              <button type="button" className="btn primary" disabled={!accepted || busy} onClick={continueWithGoogle}>
                {busy ? "جارٍ فتح Google..." : "موافق، افتح Google"}
              </button>
            </div>
          </section>
        </div>,
        document.body,
      )}
    </>
  );
}

const GOOGLE_ERRORS: Record<string, string> = {
  "google-config": "تسجيل Google غير مضبوط على الخادم بعد.",
  "google-state": "انتهت صلاحية محاولة الدخول. اضغط زر Google مرة أخرى.",
  "google-consent": "أكد موافقتك أولًا قبل المتابعة باستخدام Google.",
  google: "تعذر إتمام الدخول عبر Google. حاول مرة أخرى.",
};

function AuthPage({ register = false }: { register?: boolean }) {
  const auth = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const requestedReturnTo = params.get("returnTo") || "/";
  const returnTo = requestedReturnTo.startsWith("/") && !requestedReturnTo.startsWith("//")
    ? requestedReturnTo
    : "/";
  useEffect(() => {
    if (auth.ready && auth.user) nav(returnTo, { replace: true });
  }, [auth.ready, auth.user, nav, returnTo]);
  const [error, setError] = useState(() => GOOGLE_ERRORS[params.get("error") || ""] || "");
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [phoneCountry, setPhoneCountry] = useState<CountryCode>("SA");
  const [phone, setPhone] = useState("+966");
  const [phoneOtp, setPhoneOtp] = useState("");
  const [phoneOtpSent, setPhoneOtpSent] = useState(false);
  const [phoneCountryOpen, setPhoneCountryOpen] = useState(false);
  const [phoneCountrySearch, setPhoneCountrySearch] = useState("");
  const phoneCountryRef = useRef<HTMLDivElement>(null);
  const [authMethod, setAuthMethod] = useState<"" | "email" | "phone">(
    register ? "" : "email",
  );
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    const data = new FormData(e.currentTarget);
    try {
      if (register)
        await auth.register(
          String(data.get("name")),
          String(data.get("email")),
          String(data.get("password")),
        );
      else
        await auth.login(
          String(data.get("email")),
          String(data.get("password")),
        );
      nav(returnTo, { replace: true });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const sendPhoneOtp = async () => {
    setBusy(true);
    setError("");
    try {
      const compact = phone.replace(/[\s()-]/g, "");
      const selectedPrefix = `+${getCountryCallingCode(phoneCountry)}`;
      const withoutTrunkZero = compact.startsWith(`${selectedPrefix}0`)
        ? `${selectedPrefix}${compact.slice(selectedPrefix.length + 1)}`
        : compact;
      const parsedPhone = parsePhoneNumberFromString(withoutTrunkZero);
      if (!parsedPhone?.isValid())
        throw new Error("تحقق من رقم الجوال. بعد رمز الدولة لا تكتب الصفر الأول");
      const internationalPhone = parsedPhone.number;
      setPhone(internationalPhone);
      await auth.startPhoneLogin(internationalPhone);
      setPhoneOtpSent(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const verifyPhoneOtp = async () => {
    setBusy(true);
    setError("");
    try {
      await auth.verifyPhoneLogin(phone, phoneOtp);
      nav(returnTo, { replace: true });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const choosePhoneCountry = (country: CountryCode) => {
    setPhoneCountry(country);
    setPhone(`+${getCountryCallingCode(country)}`);
    setPhoneCountryOpen(false);
    setPhoneCountrySearch("");
  };
  const filteredPhoneCountries = useMemo(() => {
    const query = phoneCountrySearch.trim().toLocaleLowerCase("ar").replace(/^\+/, "");
    if (!query) return phoneCountries;
    return phoneCountries.filter(({ country, name, callingCode }) =>
      `${country} ${name} ${callingCode}`.toLocaleLowerCase("ar").includes(query),
    );
  }, [phoneCountrySearch]);
  useEffect(() => {
    if (!phoneCountryOpen) return;
    const close = (event: MouseEvent) => {
      if (!phoneCountryRef.current?.contains(event.target as Node)) setPhoneCountryOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPhoneCountryOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [phoneCountryOpen]);
  const submitPhone = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void (phoneOtpSent ? verifyPhoneOtp() : sendPhoneOtp());
  };
  return (
    <section className="auth-page">
      <div className="wrap auth-grid">
        <div className="auth-copy">
          <span>RETHOX MEMBERS</span>
          <h1>{register ? "ابدأ مكتبتك الخاصة." : "رجعت للقصة؟"}</h1>
          <p>
            {register
              ? "حساب واحد يحفظ كتبك، موضع قراءتك وعلاماتك."
              : "سجّل دخولك، وكل شيء ينتظرك في مكانه."}
          </p>
          <div className="auth-benefits">
            <span><Check /> مزامنة موضع القراءة</span>
            <span><Bookmark /> علامات محفوظة لكل فصل</span>
            <span><ShieldCheck /> جلسة آمنة وبيانات محمية</span>
          </div>
          <blockquote>
            “الكتاب الجيد لا ينتهي؛ فقط يغيّر المكان الذي نقرأه منه.”
          </blockquote>
        </div>
        <form className="auth-form" onSubmit={authMethod === "phone" ? submitPhone : submit}>
          <div className="auth-tabs">
            <Link className={!register ? "active" : ""} to="/login">دخول</Link>
            <Link className={register ? "active" : ""} to="/register">حساب جديد</Link>
          </div>
          {register && !authMethod ? (
            <div className="auth-choice-panel" aria-label="اختر طريقة إنشاء الحساب">
              <h2>اختر طريقة إنشاء الحساب</h2>
              <p>اختر طريقة واحدة، وبعدها نفتح لك الصفحة المناسبة لها فقط.</p>
              <GoogleSignIn className="auth-choice-card" returnTo={returnTo} />
              <button type="button" className="auth-choice-card" onClick={() => setAuthMethod("email")}>
                <b>2. التسجيل بالبريد</b>
                <small>اسم، بريد إلكتروني، وكلمة مرور.</small>
              </button>
            </div>
          ) : (
            <>
              {(register || authMethod === "phone") && (
                <button type="button" className="auth-back" onClick={() => setAuthMethod("")}>
                  {register ? "رجوع لاختيار الطريقة" : "رجوع لتسجيل الدخول"}
                </button>
              )}
              {authMethod === "phone" ? (
                <div className="phone-signup-panel">
                  <h2>{phoneOtpSent ? "أدخل رمز التحقق" : register ? "التسجيل برقم الجوال" : "الدخول برقم الجوال"}</h2>
                  <p>{phoneOtpSent
                    ? `أرسلنا رمزًا من 6 أرقام إلى ${phone}`
                    : "سنرسل لك رمز SMS لمرة واحدة. لا تحتاج إلى بريد أو كلمة مرور."}</p>
                  {!phoneOtpSent && (
                    <label className="phone-country-label">
                      الدولة ورمز الاتصال
                      <div className="phone-country-picker" ref={phoneCountryRef}>
                        <button
                          type="button"
                          className="phone-country-trigger"
                          aria-haspopup="listbox"
                          aria-expanded={phoneCountryOpen}
                          onClick={() => setPhoneCountryOpen((value) => !value)}
                          disabled={busy}
                        >
                          <span className="country-flag"><CountryFlag country={phoneCountry} /></span>
                          <span>{regionNames.of(phoneCountry)} <small dir="ltr">+{getCountryCallingCode(phoneCountry)}</small></span>
                          <ChevronDown />
                        </button>
                        {phoneCountryOpen && (
                          <div className="phone-country-menu">
                            <div className="phone-country-search"><Search /><input
                              autoFocus
                              type="search"
                              value={phoneCountrySearch}
                              onChange={(event) => setPhoneCountrySearch(event.target.value)}
                              onKeyDown={(event) => event.key === "Enter" && event.preventDefault()}
                              placeholder="ابحث باسم الدولة أو رمزها"
                              aria-label="البحث في الدول"
                            /></div>
                            <div className="phone-country-options" role="listbox" aria-label="الدول">
                              {filteredPhoneCountries.map(({ country, name, callingCode }) => (
                                <button
                                  type="button"
                                  role="option"
                                  aria-selected={country === phoneCountry}
                                  className={country === phoneCountry ? "selected" : ""}
                                  key={country}
                                  onClick={() => choosePhoneCountry(country)}
                                >
                                  <span className="country-flag"><CountryFlag country={country} /></span>
                                  <span>{name}<small>{country}</small></span>
                                  <b dir="ltr">+{callingCode}</b>
                                </button>
                              ))}
                              {!filteredPhoneCountries.length && <p>لا توجد دولة بهذا الاسم</p>}
                            </div>
                          </div>
                        )}
                      </div>
                    </label>
                  )}
                  <label>
                    رقم الجوال
                    <input
                      type="tel"
                      inputMode="tel"
                      dir="ltr"
                      value={phone}
                      onChange={(event) => setPhone(event.target.value)}
                      placeholder="+9665xxxxxxxx"
                      disabled={phoneOtpSent || busy}
                    />
                    {!phoneOtpSent && <small>يمكنك اختيار الدولة أو كتابة الرمز الدولي بنفسك، ويجب أن يبدأ الرقم بعلامة +</small>}
                  </label>
                  {phoneOtpSent && (
                    <label>
                      رمز SMS
                      <input
                        type="text"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        dir="ltr"
                        value={phoneOtp}
                        onChange={(event) => setPhoneOtp(event.target.value.replace(/\D/g, "").slice(0, 6))}
                        placeholder="000000"
                        maxLength={6}
                      />
                    </label>
                  )}
                  <button
                    type="submit"
                    className="btn primary full"
                    disabled={busy || (phoneOtpSent ? phoneOtp.length !== 6 : phone.length < 9)}
                  >
                    {busy ? "لحظة..." : phoneOtpSent ? (register ? "تأكيد وإنشاء الحساب" : "تأكيد الدخول") : "إرسال رمز SMS"}
                  </button>
                  {phoneOtpSent && (
                    <button
                      type="button"
                      className="auth-back"
                      onClick={() => { setPhoneOtpSent(false); setPhoneOtp(""); }}
                    >
                      تعديل رقم الجوال
                    </button>
                  )}
                </div>
              ) : (
                <>
                  {!register && (
                    <>
                      <GoogleSignIn className="auth-method" returnTo={returnTo} />
                      <div className="auth-divider"><span>أو بحسابك</span></div>
                    </>
                  )}
                  <div>
                    <h2>{register ? "إنشاء حساب بالبريد" : "تسجيل الدخول"}</h2>
                    <p>
                      {register ? "عندك حساب؟" : "جديد على rethox؟"}{" "}
                      <Link to={register ? "/login" : "/register"}>
                        {register ? "ادخل من هنا" : "أنشئ حسابًا"}
                      </Link>
                    </p>
                  </div>
                  {register && (
                    <label>
                      الاسم
                      <input
                        name="name"
                        required
                        minLength={2}
                        placeholder="كيف نناديك؟"
                      />
                    </label>
                  )}
                  <label>
                    البريد الإلكتروني
                    <input
                      name="email"
                      type={register ? "email" : "text"}
                      required
                      placeholder="name@example.com"
                    />
                  </label>
                  <label>
                    كلمة المرور
                    <span className="password-field">
                      <input
                        name="password"
                        type={showPassword ? "text" : "password"}
                        required
                        minLength={8}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="8 أحرف على الأقل"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((value) => !value)}
                        aria-label={showPassword ? "إخفاء كلمة المرور" : "إظهار كلمة المرور"}
                      >
                        {showPassword ? <EyeOff /> : <Eye />}
                      </button>
                    </span>
                  </label>
                  {!register && (
                    <div className="auth-options">
                      <label><input type="checkbox" /> تذكرني</label>
                      <button type="button">نسيت كلمة المرور؟</button>
                    </div>
                  )}
                </>
              )}
            </>
          )}
          {error && <p className="error">{error}</p>}
          {(!register || authMethod === "email") && (
            <button className="btn primary full" disabled={busy}>
              {busy ? "لحظة..." : register ? "أنشئ حسابي" : "دخول"}
            </button>
          )}
          <p className="auth-trust"><ShieldCheck /> اتصال آمن — لن نطلب كلمة مرورك خارج هذه الصفحة.</p>
        </form>
      </div>
    </section>
  );
}

function CartPage() {
  const { ids, remove, clear } = useCart();
  const { user } = useAuth();
  const nav = useNavigate();
  const [books, setBooks] = useState<Book[]>([]);
  const [ownedBookIds, setOwnedBookIds] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    api<{ books: Book[] }>("/books").then((r) =>
      setBooks(r.books.filter((b) => ids.includes(b.id))),
    );
  }, [ids]);
  useEffect(() => {
    if (!user) {
      setOwnedBookIds([]);
      return;
    }
    api<{ bookIds: string[] }>("/entitlements")
      .then((result) => setOwnedBookIds(result.bookIds))
      .catch(() => setOwnedBookIds([]));
  }, [user?.id]);
  useEffect(() => {
    const duplicates = ids.filter((id) => ownedBookIds.includes(id));
    if (!duplicates.length) return;
    duplicates.forEach((id) => remove(id));
    setNotice("تمت إزالة المنتجات التي سبق شراؤها من السلة.");
  }, [ids.join("|"), ownedBookIds.join("|")]);
  const total = books.reduce((s, b) => s + b.priceMinor, 0);
  const [redirecting, setRedirecting] = useState(false);
  const checkout = async () => {
    if (!user) return nav("/login");
    const purchasableIds = ids.filter((id) => !ownedBookIds.includes(id));
    if (!purchasableIds.length) {
      setNotice("هذه المنتجات تم شراؤها مسبقًا.");
      return;
    }
    try {
      setError("");
      setRedirecting(true);
      const result = await api<{ order: { id: string }; paymentUrl?: string }>("/orders", {
        method: "POST",
        body: JSON.stringify({ bookIds: purchasableIds }),
      });
      // The cart stays put until the payment settles, so an abandoned or
      // failed checkout does not wipe the reader's selection.
      if (result.paymentUrl) {
        window.location.href = result.paymentUrl;
        return;
      }
      clear();
      nav(`/account?order=${encodeURIComponent(result.order.id)}`);
    } catch (e) {
      setError((e as Error).message);
      setRedirecting(false);
    }
  };
  return (
    <section className="inner-page wrap">
      <div className="page-head">
        <span>الطلب</span>
        <h1>سلة القراءة</h1>
        <p>اخترت {ids.length} من الكتب.</p>
      </div>
      {notice && <p className="cart-notice" role="status">{notice}</p>}
      {books.length ? (
        <div className="cart-layout">
          <div className="cart-list">
            {books.map((b) => (
              <article key={b.id}>
                <div className={`cart-cover cover-${b.coverTheme}`}>
                  {b.title}
                </div>
                <div>
                  <h3>{b.title}</h3>
                  <p>
                    {b.author} · {b.genre}
                  </p>
                </div>
                <b>{b.priceMinor / 100} ر.س</b>
                <button
                  onClick={() => remove(b.id)}
                  aria-label={`حذف ${b.title}`}
                >
                  <Trash2 size={16} />
                </button>
              </article>
            ))}
          </div>
          <aside>
            <h2>ملخص</h2>
            <div>
              <span>الكتب</span>
              <b>{books.length}</b>
            </div>
            <div className="total">
              <span>الإجمالي</span>
              <b>{total / 100} ر.س</b>
            </div>
            <p>الدفع بمدى أو فيزا أو ماستركارد عبر بوابة ميسر الآمنة.</p>
            {error && <p className="error">{error}</p>}
            <button className="btn primary full" onClick={checkout} disabled={redirecting}>
              {redirecting
                ? "جارٍ تحويلك لصفحة الدفع…"
                : user
                  ? "إتمام الشراء"
                  : "سجّل الدخول وأكمل"}
            </button>
          </aside>
        </div>
      ) : (
        <div className="empty">
          <ShoppingBag size={42} />
          <h2>السلة هادئة الآن</h2>
          <p>أضف كتابًا، ودعنا نبدأ الحكاية.</p>
          <Link className="btn primary" to="/">
            تصفح المكتبة
          </Link>
        </div>
      )}
    </section>
  );
}

const ORDER_STATUS_LABELS: Record<string, string> = {
  PENDING: "بانتظار الدفع",
  COMPLETED: "مكتمل",
  CANCELLED: "ملغى",
  REFUNDED: "مسترجع",
};

function PaymentCallback() {
  const [params] = useSearchParams();
  const { clear } = useCart();
  const orderId = params.get("order") || "";
  const [state, setState] = useState<"checking" | "paid" | "failed">("checking");
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (!orderId) {
      setState("failed");
      setMessage("رابط العودة غير مكتمل.");
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let attempts = 0;
    // Moyasar can settle through the webhook a moment after the buyer returns,
    // so give the confirmation a few tries before declaring failure.
    const check = async () => {
      attempts += 1;
      try {
        const result = await api<{ status: string }>("/payments/verify", {
          method: "POST",
          body: JSON.stringify({ orderId }),
        });
        if (cancelled) return;
        if (result.status === "COMPLETED") {
          clear();
          setState("paid");
          return;
        }
        if (attempts >= 6) {
          setState("failed");
          setMessage("لم تكتمل عملية الدفع.");
          return;
        }
      } catch (e) {
        if (cancelled) return;
        if (attempts >= 6) {
          setState("failed");
          setMessage((e as Error).message);
          return;
        }
      }
      timer = setTimeout(check, 2500);
    };
    check();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [orderId]);
  return (
    <section className="inner-page wrap">
      <div className="empty">
        {state === "checking" && (
          <>
            <Loading />
            <h2>نتحقق من عملية الدفع…</h2>
            <p>لا تغلق الصفحة، تأخذ ثوانٍ قليلة.</p>
          </>
        )}
        {state === "paid" && (
          <>
            <ShieldCheck size={42} />
            <h2>تم الدفع بنجاح</h2>
            <p>أضفنا الكتب إلى مكتبتك، استمتع بالقراءة.</p>
            <Link className="btn primary" to="/account">
              اذهب إلى مكتبتي
            </Link>
          </>
        )}
        {state === "failed" && (
          <>
            <X size={42} />
            <h2>لم يكتمل الدفع</h2>
            <p>{message || "لم يُخصم أي مبلغ. تقدر تحاول مرة ثانية."}</p>
            <Link className="btn primary" to="/cart">
              العودة إلى السلة
            </Link>
          </>
        )}
      </div>
    </section>
  );
}

function SettingsPage() {
  const [settings, setSettings] = useState<ReadingSettings>(readSettings);
  const [notice, setNotice] = useState("");
  const updateSetting = <K extends keyof ReadingSettings>(key: K, value: ReadingSettings[K]) => {
    const next = { ...settings, [key]: value };
    setSettings(next);
    saveSettings(next);
    setNotice("حُفظ التغيير");
    window.setTimeout(() => setNotice(""), 1400);
  };
  const clearHistory = () => {
    localStorage.removeItem("rethox-reading-history");
    setNotice("تم مسح سجل القراءة من هذا الجهاز");
  };
  return (
    <section className="inner-page wrap standalone-settings">
      <header className="settings-page-head">
        <span className="settings-page-icon"><Settings /></span>
        <div>
          <span className="kicker">الإعدادات</span>
          <h1>اضبط تجربتك كما تحب</h1>
          <p>تُطبّق اختيارات القراءة والصوت مباشرة على جميع الفصول.</p>
        </div>
      </header>
      {notice && <div className="settings-notice" role="status"><Check /> {notice}</div>}
      <div className="settings-layout">
        <article className="settings-panel">
          <header><div><span className="kicker">القراءة</span><h2>النص والصفحة</h2></div></header>
          <label><span>حجم الخط <b>{settings.fontSize}</b></span><input type="range" min="22" max="46" step="2" value={settings.fontSize} onChange={(e) => updateSetting("fontSize", Number(e.target.value))} /></label>
          <label><span>تباعد السطور <b>{settings.lineHeight.toFixed(1)}</b></span><input type="range" min="1.7" max="2.8" step="0.1" value={settings.lineHeight} onChange={(e) => updateSetting("lineHeight", Number(e.target.value))} /></label>
          <label className="setting-toggle"><span><b>إشعارات التقدم</b><small>تنبيه هادئ عند إنهاء الفصل</small></span><input type="checkbox" checked={settings.notifications} onChange={(e) => updateSetting("notifications", e.target.checked)} /></label>
        </article>
        <article className="settings-panel">
          <header><div><span className="kicker">الصوت</span><h2>السرد والتشغيل</h2></div></header>
          <label><span>سرعة الصوت <b>{settings.playbackSpeed}×</b></span><input type="range" min="0.5" max="4" step="0.25" value={settings.playbackSpeed} onChange={(e) => updateSetting("playbackSpeed", Number(e.target.value))} /></label>
          <label><span>مستوى الصوت <b>{Math.round(settings.volume * 100)}%</b></span><input type="range" min="0" max="1" step="0.05" value={settings.volume} onChange={(e) => updateSetting("volume", Number(e.target.value))} /></label>
          <label className="setting-toggle"><span><b>تشغيل السرد تلقائيًا</b><small>يبدأ عند فتح الفصل عندما يسمح المتصفح</small></span><input type="checkbox" checked={settings.autoNarration} onChange={(e) => updateSetting("autoNarration", e.target.checked)} /></label>
        </article>
        <article className="settings-panel settings-privacy-panel">
          <header><div><span className="kicker">الخصوصية</span><h2>السجل على جهازك</h2></div></header>
          <label className="setting-toggle"><span><b>سجل خاص</b><small>لا يظهر سجل القراءة لزوار ملفك</small></span><input type="checkbox" checked={settings.privateHistory} onChange={(e) => updateSetting("privateHistory", e.target.checked)} /></label>
          <button className="history-clear" onClick={clearHistory}><Trash2 /> مسح سجل القراءة من هذا الجهاز</button>
        </article>
      </div>
    </section>
  );
}

function AccountPage() {
  const { user, ready, logout, updateProfile } = useAuth();
  const [accountParams] = useSearchParams();
  const completedOrderId = accountParams.get("order");
  const [orders, setOrders] = useState<any[]>([]);
  const [bookIds, setBookIds] = useState<string[]>([]);
  const [books, setBooks] = useState<Book[]>([]);
  const [readingListIds, setReadingListIds] = useState<string[]>([]);
  const [history] = useState<ReadingHistoryItem[]>(readHistory);
  const [profileName, setProfileName] = useState("");
  const [profileAvatar, setProfileAvatar] = useState("");
  const [profileMessage, setProfileMessage] = useState("");
  const [profileAvatarBusy, setProfileAvatarBusy] = useState(false);
  const [avatarEditorSrc, setAvatarEditorSrc] = useState("");
  const [avatarNaturalSize, setAvatarNaturalSize] = useState({ width: 1, height: 1 });
  const [avatarZoom, setAvatarZoom] = useState(1);
  const [avatarOffset, setAvatarOffset] = useState({ x: 0, y: 0 });
  const avatarCropRef = useRef<HTMLDivElement>(null);
  const avatarCropImageRef = useRef<HTMLImageElement>(null);
  const avatarDragRef = useRef<{ pointerId: number; x: number; y: number; offsetX: number; offsetY: number } | null>(null);
  const totalReadingSeconds = history.reduce((total, item) => total + (item.seconds || 0), 0);
  const completedCount = (() => {
    try { return JSON.parse(localStorage.getItem("rethox-completed-chapters") || "[]").length; }
    catch { return 0; }
  })();
  useEffect(() => {
    if (user) {
      setProfileName(user.name);
      setProfileAvatar(user.avatarUrl || "");
    }
  }, [user?.id]);
  useEffect(() => () => {
    if (avatarEditorSrc) URL.revokeObjectURL(avatarEditorSrc);
  }, [avatarEditorSrc]);
  useEffect(() => {
    if (!user) return;
    api<{ orders: any[] }>("/orders").then((result) => setOrders(result.orders)).catch(() => setOrders([]));
    api<{ bookIds: string[] }>("/entitlements").then((result) => setBookIds(result.bookIds)).catch(() => setBookIds([]));
    api<{ books: Book[] }>("/books").then((result) => setBooks(result.books)).catch(() => setBooks([]));
    api<{ bookIds: string[] }>("/reading-list").then((result) => setReadingListIds(result.bookIds)).catch(() => setReadingListIds([]));
  }, [user, completedOrderId]);
  const saveProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      await updateProfile({ name: profileName.trim(), avatarUrl: profileAvatar.trim() || undefined });
      setProfileMessage("تم حفظ الملف الشخصي");
    } catch (error) {
      setProfileMessage((error as Error).message);
    }
  };
  const uploadProfileAvatar = async (file?: File) => {
    if (!user || !file || profileAvatarBusy) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setProfileMessage("اختر صورة JPG أو PNG أو WEBP");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setProfileMessage("حجم الصورة يجب ألا يتجاوز 5MB");
      return;
    }
    setProfileAvatarBusy(true);
    setProfileMessage("جارٍ رفع الصورة...");
    try {
      const uploaded = await api<{ avatarUrl: string }>("/auth/avatar", {
        method: "POST",
        headers: { "content-type": file.type },
        body: file,
      });
      setProfileAvatar(uploaded.avatarUrl);
      await updateProfile({ name: profileName.trim() || user.name, avatarUrl: uploaded.avatarUrl });
      setProfileMessage("تم تحديث صورتك");
      setAvatarEditorSrc("");
    } catch (error) {
      setProfileMessage((error as Error).message);
    } finally {
      setProfileAvatarBusy(false);
    }
  };
  const chooseProfileAvatar = async (file?: File) => {
    if (!file) return;
    const extension = file.name.split(".").pop()?.toLowerCase() || "";
    const imageExtensions = new Set(["jpg", "jpeg", "jfif", "png", "webp", "avif", "gif", "bmp", "svg", "ico", "heic", "heif", "tif", "tiff"]);
    if (!file.type.startsWith("image/") && !imageExtensions.has(extension)) {
      setProfileMessage("الملف المختار ليس صورة");
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      setProfileMessage("حجم الصورة الأصلية يجب ألا يتجاوز 25MB");
      return;
    }
    setProfileAvatarBusy(true);
    setProfileMessage("جارٍ تجهيز الصورة...");
    try {
      let previewBlob: Blob = file;
      const isHeic = ["heic", "heif"].includes(extension) || ["image/heic", "image/heif"].includes(file.type.toLowerCase());
      const isTiff = ["tif", "tiff"].includes(extension) || ["image/tif", "image/tiff"].includes(file.type.toLowerCase());
      if (isHeic) {
        const { default: heic2any } = await import("heic2any");
        const converted = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.96 });
        previewBlob = Array.isArray(converted) ? converted[0] : converted;
      } else if (isTiff) {
        const UTIF = await import("utif");
        const buffer = await file.arrayBuffer();
        const pages = UTIF.decode(buffer);
        if (!pages.length) throw new Error("تعذر قراءة ملف TIFF");
        UTIF.decodeImage(buffer, pages[0], pages);
        const rgba = UTIF.toRGBA8(pages[0]);
        const canvas = document.createElement("canvas");
        canvas.width = pages[0].width;
        canvas.height = pages[0].height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("تعذر تجهيز الصورة في هذا المتصفح");
        context.putImageData(new ImageData(new Uint8ClampedArray(rgba), canvas.width, canvas.height), 0, 0);
        previewBlob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("تعذر تحويل ملف TIFF")), "image/png"));
      }
      setAvatarNaturalSize({ width: 1, height: 1 });
      setAvatarZoom(1);
      setAvatarOffset({ x: 0, y: 0 });
      setAvatarEditorSrc(URL.createObjectURL(previewBlob));
      setProfileMessage("");
    } catch {
      setAvatarEditorSrc("");
      setProfileMessage("تعذر قراءة هذه الصورة. جرّب نسخة أخرى منها");
    } finally {
      setProfileAvatarBusy(false);
    }
  };
  const clampAvatarOffset = (x: number, y: number, zoom = avatarZoom) => {
    const viewport = avatarCropRef.current?.clientWidth || 280;
    const aspect = avatarNaturalSize.width / avatarNaturalSize.height;
    const baseWidth = aspect >= 1 ? viewport * aspect : viewport;
    const baseHeight = aspect >= 1 ? viewport : viewport / aspect;
    const maxX = Math.max(0, (baseWidth * zoom - viewport) / 2);
    const maxY = Math.max(0, (baseHeight * zoom - viewport) / 2);
    return {
      x: Math.max(-maxX, Math.min(maxX, x)),
      y: Math.max(-maxY, Math.min(maxY, y)),
    };
  };
  const changeAvatarZoom = (nextZoom: number) => {
    const value = Math.max(1, Math.min(4, nextZoom));
    setAvatarZoom(value);
    setAvatarOffset((current) => clampAvatarOffset(current.x, current.y, value));
  };
  const startAvatarDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (profileAvatarBusy) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    avatarDragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      offsetX: avatarOffset.x,
      offsetY: avatarOffset.y,
    };
  };
  const moveAvatar = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = avatarDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setAvatarOffset(clampAvatarOffset(
      drag.offsetX + event.clientX - drag.x,
      drag.offsetY + event.clientY - drag.y,
    ));
  };
  const stopAvatarDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (avatarDragRef.current?.pointerId === event.pointerId) avatarDragRef.current = null;
  };
  const saveCroppedAvatar = async () => {
    const image = avatarCropImageRef.current;
    const viewport = avatarCropRef.current;
    if (!image || !viewport || !image.naturalWidth || profileAvatarBusy) return;
    const outputSize = 1024;
    const viewSize = viewport.clientWidth;
    const canvas = document.createElement("canvas");
    canvas.width = outputSize;
    canvas.height = outputSize;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return setProfileMessage("تعذر تجهيز الصورة في هذا المتصفح");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, outputSize, outputSize);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    const baseScale = Math.max(viewSize / image.naturalWidth, viewSize / image.naturalHeight);
    const outputScale = outputSize / viewSize;
    const scale = baseScale * avatarZoom * outputScale;
    context.setTransform(
      scale,
      0,
      0,
      scale,
      outputSize / 2 + avatarOffset.x * outputScale,
      outputSize / 2 + avatarOffset.y * outputScale,
    );
    context.drawImage(image, -image.naturalWidth / 2, -image.naturalHeight / 2);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.94));
    if (!blob) return setProfileMessage("تعذر تجهيز الصورة في هذا المتصفح");
    await uploadProfileAvatar(new File([blob], "avatar.webp", { type: "image/webp" }));
  };
  if (!ready) return <Loading />;
  if (!user) return <Navigate to="/login" />;
  return (
    <section className="inner-page wrap">
      <div className="account-head">
        {user.avatarUrl ? (
          <img className="avatar" src={user.avatarUrl} alt="" referrerPolicy="no-referrer" />
        ) : (
          <div className="avatar">{user.name[0]}</div>
        )}
        <div>
          <span>أهلًا بعودتك</span>
          <h1>{user.name}</h1>
          <p>{user.email}</p>
        </div>
        <button className="btn secondary" onClick={() => { void logout(); }}>
          تسجيل الخروج
        </button>
      </div>
      <form className="profile-editor" onSubmit={saveProfile}>
        <div><span className="kicker">الملف الشخصي</span><h2>كيف يظهر اسمك للقراء؟</h2></div>
        <label>الاسم الظاهر<input value={profileName} onChange={(event) => setProfileName(event.target.value)} minLength={2} maxLength={60} required /></label>
        <div className="profile-avatar-field">
          <span>الصورة الشخصية</span>
          <div className="profile-avatar-picker">
            {profileAvatar ? <img src={profileAvatar} alt="معاينة الصورة الشخصية" /> : <i>{profileName[0] || user.name[0]}</i>}
            <label className="avatar-file-button">
              <ImagePlus size={16} />
              {profileAvatarBusy ? "جارٍ الرفع..." : "اختر من جهازك"}
              <input
                type="file"
                accept="image/*,.heic,.heif,.tif,.tiff,.jfif,.avif"
                disabled={profileAvatarBusy}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  void chooseProfileAvatar(file);
                }}
              />
            </label>
          </div>
          <small>تعمل من الجوال والكمبيوتر · حتى 5MB</small>
        </div>
        <button className="btn secondary">حفظ التغييرات</button>
        {profileMessage && <small className="profile-message" aria-live="polite">{profileMessage}</small>}
      </form>
      {avatarEditorSrc && createPortal(
        <div className="avatar-editor-backdrop" role="presentation" onPointerDown={(event) => {
          if (event.target === event.currentTarget && !profileAvatarBusy) setAvatarEditorSrc("");
        }}>
          <section className="avatar-editor" role="dialog" aria-modal="true" aria-labelledby="avatar-editor-title">
            <header>
              <div><span className="kicker">الصورة الشخصية</span><h2 id="avatar-editor-title">اضبط ظهور صورتك</h2></div>
              <button type="button" aria-label="إغلاق" disabled={profileAvatarBusy} onClick={() => setAvatarEditorSrc("")}><X size={18} /></button>
            </header>
            <div
              ref={avatarCropRef}
              className="avatar-crop-viewport"
              onPointerDown={startAvatarDrag}
              onPointerMove={moveAvatar}
              onPointerUp={stopAvatarDrag}
              onPointerCancel={stopAvatarDrag}
            >
              <img
                ref={avatarCropImageRef}
                src={avatarEditorSrc}
                alt="معاينة موضع الصورة"
                draggable={false}
                onLoad={(event) => setAvatarNaturalSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
                onError={() => { setAvatarEditorSrc(""); setProfileMessage("تعذر عرض هذه الصورة. جرّب نسخة أخرى منها"); }}
                style={{
                  left: `calc(50% + ${avatarOffset.x}px)`,
                  top: `calc(50% + ${avatarOffset.y}px)`,
                  width: avatarNaturalSize.width >= avatarNaturalSize.height ? `${(avatarNaturalSize.width / avatarNaturalSize.height) * 100}%` : "100%",
                  height: avatarNaturalSize.width >= avatarNaturalSize.height ? "100%" : `${(avatarNaturalSize.height / avatarNaturalSize.width) * 100}%`,
                  transform: `translate(-50%, -50%) scale(${avatarZoom})`,
                }}
              />
              <div className="avatar-crop-ring" aria-hidden="true" />
              <small>اسحب الصورة لتحديد موضعها</small>
            </div>
            <div className="avatar-zoom-control">
              <button type="button" aria-label="تصغير الصورة" onClick={() => changeAvatarZoom(avatarZoom - 0.1)}><Minus size={17} /></button>
              <input aria-label="تكبير الصورة" type="range" min="1" max="4" step="0.05" value={avatarZoom} onChange={(event) => changeAvatarZoom(Number(event.target.value))} />
              <button type="button" aria-label="تكبير الصورة" onClick={() => changeAvatarZoom(avatarZoom + 0.1)}><Plus size={17} /></button>
              <output>{Math.round(avatarZoom * 100)}%</output>
            </div>
            <button className="avatar-position-reset" type="button" onClick={() => { setAvatarZoom(1); setAvatarOffset({ x: 0, y: 0 }); }}>
              <RotateCcw size={15} /> إعادة الضبط
            </button>
            <footer>
              <button className="btn secondary" type="button" disabled={profileAvatarBusy} onClick={() => setAvatarEditorSrc("")}>إلغاء</button>
              <button className="btn primary" type="button" disabled={profileAvatarBusy} onClick={() => void saveCroppedAvatar()}>{profileAvatarBusy ? "جارٍ الحفظ..." : "استخدم هذه الصورة"}</button>
            </footer>
          </section>
        </div>,
        document.body,
      )}
      <div className="account-grid">
        <div>
          <div className="subhead">
            <h2>مكتبتي</h2>
            <span>{bookIds.length} كتاب</span>
          </div>
          <div className="library-grid">
            {books
              .filter((b) => bookIds.includes(b.id))
              .map((b) => (
                <BookCard key={b.id} book={b} index={0} />
              ))}
            {bookIds.length === 0 && (
              <div className="panel-empty">
                <Library />
                <p>مكتبتك تنتظر أول كتاب.</p>
                <Link to="/">استكشف الكتب</Link>
              </div>
            )}
          </div>
        </div>
        <aside className="orders">
          <h2>طلباتي</h2>
          {orders.map((o) => (
            <div key={o.id}>
              <span>طلب #{o.id.slice(0, 6)}</span>
              <b>{o.totalMinor / 100} ر.س</b>
              <small>{ORDER_STATUS_LABELS[o.status] || "مكتمل"}</small>
            </div>
          ))}
          {!orders.length && <p>لا توجد طلبات بعد.</p>}
        </aside>
      </div>
      {completedOrderId && (
        <div className="order-success" role="status">
          <i><Check size={18} /></i>
          <div>
            <b>تمت إضافة الرواية إلى مكتبتك</b>
            <span>رقم الطلب: RX-{completedOrderId.slice(0, 8).toUpperCase()}</span>
          </div>
          <Link to="/account">إخفاء</Link>
        </div>
      )}
      <section className="reading-later-section">
        <div className="subhead">
          <h2>القراءة لاحقًا</h2>
          <span>{readingListIds.length} محفوظة</span>
        </div>
        <div className="library-grid">
          {books.filter((book) => readingListIds.includes(book.id)).map((book) => (
            <BookCard key={book.id} book={book} index={0} />
          ))}
          {!readingListIds.length && (
            <div className="panel-empty"><Bookmark /><p>احفظ أي رواية لتجدها هنا.</p><Link to="/">استكشف المكتبة</Link></div>
          )}
        </div>
      </section>
      <section className="account-dashboard">
        <div className="reading-stats">
          <article><Clock /><b>{Math.floor(totalReadingSeconds / 3600)} س</b><span>وقت القراءة</span></article>
          <article><BookOpen /><b>{history.length}</b><span>جلسات القراءة</span></article>
          <article><Check /><b>{completedCount}</b><span>فصول منجزة</span></article>
        </div>
        <article className="history-panel">
          <header><div><span className="kicker">آخر نشاط</span><h2>سجل القراءة</h2></div><span>{history.length} جلسة</span></header>
          <div className="history-list">
            {history.slice(0, 8).map((item) => (
              <Link key={`${item.chapterId}-${item.visitedAt}`} to={`/reader/${item.chapterId}`}>
                <BookOpen /><div><b>{item.bookTitle}</b><small>{item.chapterTitle}</small></div><time>{formatDateTime(item.visitedAt)}</time><ChevronLeft />
              </Link>
            ))}
            {!history.length && <p>سيظهر هنا ما تقرؤه والوقت الذي قضيته.</p>}
          </div>
        </article>
      </section>
    </section>
  );
}

function ReaderPage() {
  const { chapterId } = useParams();
  const nav = useNavigate();
  const location = useLocation();
  const sectionSentenceId = new URLSearchParams(location.search).get("section") || "";
  const { user, ready } = useAuth();
  const [chapter, setChapter] = useState<Chapter | null>(null);
  const [book, setBook] = useState<any>(null);
  const [chapterNav, setChapterNav] = useState<{
    previous: { id: string; title: string; sentenceCount?: number; locked?: boolean } | null;
    next: { id: string; title: string; sentenceCount?: number; locked?: boolean } | null;
  }>({ previous: null, next: null });
  const [chapterList, setChapterList] = useState<
    { id: string; title: string; position: number; locked?: boolean }[]
  >([]);
  const [lockedChapter, setLockedChapter] = useState<{ id: string; title: string } | null>(null);
  const [showChapterList, setShowChapterList] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [atChapterEnd, setAtChapterEnd] = useState(false);
  const [transitionTitle, setTransitionTitle] = useState("");
  const [sectionTargetId, setSectionTargetId] = useState("");
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [chapterComments, setChapterComments] = useState<ChapterComment[]>([]);
  const [chapterRating, setChapterRating] = useState(5);
  const [chapterRatingFilter, setChapterRatingFilter] = useState(0);
  const [chapterCommentBody, setChapterCommentBody] = useState("");
  const [chapterCommentSpoiler, setChapterCommentSpoiler] = useState(false);
  const [chapterCommentMessage, setChapterCommentMessage] = useState("");
  const [replyBodies, setReplyBodies] = useState<Record<string, string>>({});
  const [playing, setPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const [currentSentenceIndex, setCurrentSentenceIndex] = useState(() =>
    Number(localStorage.getItem(`rethox-sentence-${chapterId}`) || 0),
  );
  const [activeWordId, setActiveWordId] = useState("");
  const [speed, setSpeed] = useState(() => {
    const saved = Number(localStorage.getItem("rethox-playback-speed") || 1);
    return Number.isFinite(saved) ? Math.min(4, Math.max(0.5, saved)) : 1;
  });
  const [narrationBusy, setNarrationBusy] = useState(false);
  const [narrationDuration, setNarrationDuration] = useState(0);
  const [ttsBoundaries, setTtsBoundaries] = useState<
    { text: string; startMs: number; endMs: number }[]
  >([]);
  const initialSettings = useMemo(readSettings, []);
  const [fontSize, setFontSize] = useState(initialSettings.fontSize);
  const [lineHeight] = useState(initialSettings.lineHeight);
  const [summary, setSummary] = useState("");
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [activeSentence, setActiveSentence] = useState<Sentence | null>(null);
  const [playerError, setPlayerError] = useState("");
  const [savedSentenceIds, setSavedSentenceIds] = useState<string[]>([]);
  const [saveNotice, setSaveNotice] = useState("");
  const [showAuthPrompt, setShowAuthPrompt] = useState(false);
  const [showSavedList, setShowSavedList] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [openIllustration, setOpenIllustration] = useState<{ src: string; alt: string } | null>(null);
  const [illustrationView, setIllustrationView] = useState({ scale: 1, x: 0, y: 0 });
  const [illustrationDragging, setIllustrationDragging] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [reportText, setReportText] = useState("");
  const [reportNotice, setReportNotice] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  const [volume, setVolume] = useState(initialSettings.volume);
  const [scrollRatio, setScrollRatio] = useState(0);
  const volumeRef = useRef(volume);
  const illustrationDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const railRef = useRef<HTMLDivElement | null>(null);
  const railDraggingRef = useRef(false);
  const scrollHoldRef = useRef(0);
  const scrollAnimRef = useRef(0);
  const manualProgressFrameRef = useRef(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const browserSpeechActiveRef = useRef(false);
  const playbackSessionRef = useRef(0);
  const activeWordRef = useRef("");
  const speedRef = useRef(speed);
  const backgroundNarrationRef = useRef<Promise<void> | null>(null);
  const preparationRef = useRef<{
    key: string;
    promise: Promise<PreparedNarrationSegment[]>;
  } | null>(null);
  const animationRef = useRef(0);
  const trackingFramePendingRef = useRef(false);
  const lastTrackedBoundaryRef = useRef(-1);
  const currentSegmentRef = useRef(0);
  const readerBodyRef = useRef<HTMLElement | null>(null);
  const historyEntryRef = useRef("");
  const currentMsRef = useRef(0);
  const currentSentenceIndexRef = useRef(currentSentenceIndex);
  const playingRef = useRef(playing);
  const atChapterEndRef = useRef(atChapterEnd);
  const lastTimelinePaintRef = useRef(0);
  const lastSpotSaveRef = useRef({ sentenceIndex: -1, wordId: "", at: 0 });
  const lastAutoScrollRef = useRef(0);
  const sectionHighlightTimerRef = useRef(0);
  const rememberReadingSpot = (sentenceIndex: number, wordId = activeWordRef.current) => {
    const now = Date.now();
    if (
      lastSpotSaveRef.current.sentenceIndex === sentenceIndex &&
      lastSpotSaveRef.current.wordId === wordId &&
      now - lastSpotSaveRef.current.at < 250
    ) return;
    lastSpotSaveRef.current = { sentenceIndex, wordId, at: now };
    localStorage.setItem(`rethox-sentence-${chapterId}`, String(sentenceIndex));
    if (wordId) localStorage.setItem(`rethox-word-${chapterId}`, wordId);
    if (book && chapter) {
      const precisePosition = chapterReadingPercentage(
        chapter,
        sentenceIndex,
        wordId,
        atChapterEndRef.current,
      ) / 100 * (chapter.sentences.length || 1);
      localStorage.setItem(
        "rethox-last-read",
        JSON.stringify({
          bookSlug: book.slug,
          bookTitle: book.title,
          chapterId: chapter.id,
          chapterTitle: chapter.title,
          position: Math.min(chapter.sentences.length, precisePosition),
          total: chapter.sentences.length || 1,
          sentenceId: chapter.sentences[sentenceIndex]?.id,
          wordId,
        }),
      );
    }
  };
  const revealActiveWord = (wordId: string) => {
    const now = performance.now();
    if (now - lastAutoScrollRef.current < 500) return;
    lastAutoScrollRef.current = now;
    const target = document.querySelector<HTMLElement>(`[data-word-id="${wordId}"]`);
    const container = readerBodyRef.current;
    if (!target || !container) return;
    const targetRect = target.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    if (targetRect.top < containerRect.top + 90 || targetRect.bottom > containerRect.bottom - 120) {
      target.scrollIntoView({
        block: "center",
        behavior: window.matchMedia("(max-width: 600px)").matches ? "auto" : "smooth",
      });
    }
  };
  const applyPlaybackSpeed = (value: number) => {
    const next = Number.isFinite(value)
      ? Math.min(4, Math.max(0.5, value))
      : 1;
    speedRef.current = next;
    setSpeed(next);
    localStorage.setItem("rethox-playback-speed", String(next));
    [audioRef.current, previewAudioRef.current].forEach((audio) => {
      if (!audio) return;
      audio.defaultPlaybackRate = next;
      audio.playbackRate = next;
    });
  };
  const releaseAudio = (audio: HTMLAudioElement | null) => {
    if (!audio) return;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  };
  const primeAudioPlayback = () => {
    const audio = new Audio(
      "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQQAAACAgICA",
    );
    audio.preload = "auto";
    audio.loop = true;
    audio.muted = true;
    audio.volume = 0;
    audio.defaultPlaybackRate = speedRef.current;
    audioRef.current = audio;
    void audio.play().catch(() => {});
  };
  const stopAllPlayback = () => {
    const session = ++playbackSessionRef.current;
    cancelAnimationFrame(animationRef.current);
    trackingFramePendingRef.current = false;
    releaseAudio(audioRef.current);
    releaseAudio(previewAudioRef.current);
    audioRef.current = null;
    previewAudioRef.current = null;
    browserSpeechActiveRef.current = false;
    backgroundNarrationRef.current = null;
    lastTrackedBoundaryRef.current = -1;
    window.speechSynthesis.cancel();
    setPlaying(false);
    return session;
  };
  useEffect(() => {
    if (!chapterId || !ready) return;
    stopAllPlayback();
    preparationRef.current = null;
    backgroundNarrationRef.current = null;
    currentSegmentRef.current = 0;
    setTtsBoundaries([]);
    setNarrationDuration(0);
    setCurrentMs(0);
    setActiveWordId("");
    setPlayerError("");
    setSaveNotice("");
    setAtChapterEnd(false);
    atChapterEndRef.current = false;
    setShowChapterList(false);
    setTransitionTitle("");
    try {
      setSavedSentenceIds(
        JSON.parse(localStorage.getItem(`rethox-bookmarks-${chapterId}`) || "[]"),
      );
    } catch {
      setSavedSentenceIds([]);
    }
    setCurrentSentenceIndex(
      Number(localStorage.getItem(`rethox-sentence-${chapterId}`) || 0),
    );
    let active = true;
    getChapterContent(chapterId)
      .then((r) => {
        let savedIndex = Number(localStorage.getItem(`rethox-sentence-${chapterId}`) || 0);
        let savedWordId = localStorage.getItem(`rethox-word-${chapterId}`) || "";
        const requestedSectionIndex = sectionSentenceId
          ? r.chapter.sentences.findIndex((sentence: Sentence) => sentence.id === sectionSentenceId)
          : -1;
        if (requestedSectionIndex >= 0) {
          savedIndex = requestedSectionIndex;
          savedWordId = "";
        }
        savedIndex = Math.min(Math.max(0, savedIndex), Math.max(0, r.chapter.sentences.length - 1));
        localStorage.setItem(`rethox-sentence-${chapterId}`, String(savedIndex));
        if (savedWordId) localStorage.setItem(`rethox-word-${chapterId}`, savedWordId);
        else localStorage.removeItem(`rethox-word-${chapterId}`);
        currentSentenceIndexRef.current = savedIndex;
        activeWordRef.current = savedWordId;
        setCurrentSentenceIndex(savedIndex);
        setActiveWordId(savedWordId);
        setChapter(r.chapter);
        setBook(r.book);
        setChapterNav(r.navigation || { previous: null, next: null });
        setChapterList(r.chapterList || []);
        setActiveSentence(r.chapter.sentences[savedIndex] || r.chapter.sentences[0]);
        localStorage.setItem(
          "rethox-last-read",
          JSON.stringify({
            bookSlug: r.book.slug,
            bookTitle: r.book.title,
            chapterId: r.chapter.id,
            chapterTitle: r.chapter.title,
            position: Math.min(r.chapter.sentences.length, savedIndex),
            total: r.chapter.sentences.length || 1,
            sentenceId: r.chapter.sentences[savedIndex]?.id,
            wordId: savedWordId || undefined,
          }),
        );
        const history = readHistory();
        const entry: ReadingHistoryItem = {
          bookSlug: r.book.slug,
          bookTitle: r.book.title,
          chapterId: r.chapter.id,
          chapterTitle: r.chapter.title,
          position: Math.min(r.chapter.sentences.length, savedIndex),
          total: r.chapter.sentences.length || 1,
          visitedAt: new Date().toISOString(),
          seconds: 0,
        };
        historyEntryRef.current = entry.visitedAt;
        localStorage.setItem("rethox-reading-history", JSON.stringify([entry, ...history].slice(0, 60)));
        // Progress sync must never delay showing the text.  It updates the
        // reading spot only when the reader did not explicitly choose a section.
        if (user && !sectionSentenceId) {
          void api<{ progress: Progress | null }>(`/progress/${r.book.id}`)
            .then((saved) => {
              if (!active) return;
              const progress = saved.progress;
              if (!progress || progress.chapterId !== r.chapter.id) return;
              const remoteSentenceIndex = progress.sentenceId
                ? r.chapter.sentences.findIndex((sentence) => sentence.id === progress.sentenceId)
                : -1;
              if (remoteSentenceIndex < 0) return;
              const remoteWordId = progress.wordId || "";
              localStorage.setItem(`rethox-sentence-${chapterId}`, String(remoteSentenceIndex));
              if (remoteWordId) localStorage.setItem(`rethox-word-${chapterId}`, remoteWordId);
              else localStorage.removeItem(`rethox-word-${chapterId}`);
              currentSentenceIndexRef.current = remoteSentenceIndex;
              activeWordRef.current = remoteWordId;
              setCurrentSentenceIndex(remoteSentenceIndex);
              setActiveWordId(remoteWordId);
              setActiveSentence(r.chapter.sentences[remoteSentenceIndex] || r.chapter.sentences[0]);
            })
            .catch(() => {
              // The local reading spot remains a safe offline fallback.
            });
        }
      })
      .catch((error) => {
        if (!active) return;
        if (error instanceof ApiError && error.status === 403) {
          const lockedBook = error.data.book as { slug?: string } | undefined;
          const locked = error.data.chapter as { id?: string } | undefined;
          if (lockedBook?.slug && locked?.id) {
            nav(`/book/${lockedBook.slug}?locked=${encodeURIComponent(locked.id)}`, { replace: true });
            return;
          }
        }
        nav("/");
      });
    fetchChapterComments(chapterId)
      .then((items) => setChapterComments(items))
      .catch(() => setChapterComments([]));
    return () => { active = false; };
  }, [chapterId, ready, sectionSentenceId, user?.id]);
  useEffect(() => {
    if (!chapter) return;
    const timer = window.setInterval(() => {
      const history = readHistory();
      const current = history.find((item) => item.visitedAt === historyEntryRef.current);
      if (current) current.seconds = (current.seconds || 0) + 15;
      localStorage.setItem("rethox-reading-history", JSON.stringify(history));
    }, 15000);
    return () => window.clearInterval(timer);
  }, [chapter?.id]);
  useEffect(() => {
    speedRef.current = speed;
    if (audioRef.current) {
      audioRef.current.defaultPlaybackRate = speed;
      audioRef.current.playbackRate = speed;
    }
    if (previewAudioRef.current) {
      previewAudioRef.current.defaultPlaybackRate = speed;
      previewAudioRef.current.playbackRate = speed;
    }
  }, [speed]);
  useEffect(() => {
    volumeRef.current = volume;
    const savedSettings = readSettings();
    if (savedSettings.volume !== volume) saveSettings({ ...savedSettings, volume });
    else localStorage.setItem("rethox-volume", String(volume));
    if (audioRef.current) audioRef.current.volume = volume;
    if (previewAudioRef.current) previewAudioRef.current.volume = volume;
  }, [volume]);
  useEffect(() => {
    if (!chapter) return;
    const savedWord = sectionSentenceId ? "" : localStorage.getItem(`rethox-word-${chapterId}`) || "";
    const savedIndex = sectionSentenceId
      ? Math.max(0, chapter.sentences.findIndex((sentence) => sentence.id === sectionSentenceId))
      : Number(localStorage.getItem(`rethox-sentence-${chapterId}`) || 0);
    window.requestAnimationFrame(() => {
      const target =
        (sectionSentenceId && document.querySelector(`[data-sentence-id="${sectionSentenceId}"]`)) ||
        (savedWord && document.querySelector(`[data-word-id="${savedWord}"]`)) ||
        document.querySelector(`[data-sentence-index="${savedIndex}"]`);
      target?.scrollIntoView({ block: "center", behavior: sectionSentenceId ? "auto" : "smooth" });
      if (savedWord) {
        activeWordRef.current = savedWord;
        setActiveWordId(savedWord);
      }
    });
  }, [chapter?.id, chapterId, sectionSentenceId]);
  useEffect(
    () => () => {
      playbackSessionRef.current += 1;
      cancelAnimationFrame(animationRef.current);
      releaseAudio(audioRef.current);
      releaseAudio(previewAudioRef.current);
      audioRef.current = null;
      previewAudioRef.current = null;
      window.speechSynthesis.cancel();
    },
    [],
  );
  useEffect(() => {
    currentMsRef.current = currentMs;
  }, [currentMs]);
  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);
  useEffect(() => {
    atChapterEndRef.current = atChapterEnd;
  }, [atChapterEnd]);
  useEffect(() => {
    rememberReadingSpot(currentSentenceIndex);
    currentSentenceIndexRef.current = currentSentenceIndex;
  }, [currentSentenceIndex]);
  useEffect(() => {
    if (!user || !chapter) return;
    const persistProgress = () => saveReadingProgress({
      bookId: chapter.bookId,
      chapterId: chapter.id,
      sentenceId: chapter.sentences[currentSentenceIndexRef.current]?.id,
      wordId: activeWordRef.current || undefined,
      positionMs: currentMsRef.current,
      percentage: chapterReadingPercentage(
        chapter,
        currentSentenceIndexRef.current,
        activeWordRef.current,
        atChapterEndRef.current,
      ),
    }).catch(() => {});
    const timer = window.setInterval(persistProgress, 10000);
    return () => {
      window.clearInterval(timer);
      void persistProgress();
    };
  }, [user?.id, chapter?.id]);
  const durationMs = narrationDuration || 1;
  useEffect(() => {
    const container = readerBodyRef.current;
    if (!container || !chapter) return;
    const onScroll = () => {
      const remaining = container.scrollHeight - container.scrollTop - container.clientHeight;
      const scrollable = container.scrollHeight - container.clientHeight;
      setScrollRatio(scrollable > 0 ? container.scrollTop / scrollable : 0);
      setShowScrollTop(container.scrollTop > 700);
      if (!playingRef.current) {
        cancelAnimationFrame(manualProgressFrameRef.current);
        manualProgressFrameRef.current = requestAnimationFrame(() => {
          const center = container.getBoundingClientRect().top + container.clientHeight * 0.45;
          let closestIndex = currentSentenceIndexRef.current;
          let closestDistance = Number.POSITIVE_INFINITY;
          container.querySelectorAll<HTMLElement>("[data-sentence-index]").forEach((item) => {
            const rect = item.getBoundingClientRect();
            if (rect.bottom < container.getBoundingClientRect().top || rect.top > container.getBoundingClientRect().bottom) return;
            const distance = Math.abs(rect.top + rect.height / 2 - center);
            if (distance < closestDistance) {
              closestDistance = distance;
              closestIndex = Number(item.dataset.sentenceIndex || 0);
            }
          });
          if (closestIndex !== currentSentenceIndexRef.current) {
            currentSentenceIndexRef.current = closestIndex;
            setCurrentSentenceIndex(closestIndex);
            rememberReadingSpot(closestIndex, "");
          }
        });
      }
      if (remaining < 180) {
        setAtChapterEnd(true);
        atChapterEndRef.current = true;
        rememberReadingSpot(Math.max(0, chapter.sentences.length - 1), "");
        try {
          const completed: string[] = JSON.parse(
            localStorage.getItem("rethox-completed-chapters") || "[]",
          );
          if (!completed.includes(chapter.id)) {
            completed.push(chapter.id);
            localStorage.setItem("rethox-completed-chapters", JSON.stringify(completed));
          }
        } catch {}
      }
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(manualProgressFrameRef.current);
    };
  }, [chapter]);
  useEffect(() => {
    if (durationMs && currentMs >= durationMs) setPlaying(false);
  }, [currentMs, durationMs]);
  useEffect(() => {
    if (!atChapterEnd || !chapter) return;
    try {
      const completed: string[] = JSON.parse(localStorage.getItem("rethox-completed-chapters") || "[]");
      if (!completed.includes(chapter.id)) {
        completed.push(chapter.id);
        localStorage.setItem("rethox-completed-chapters", JSON.stringify(completed));
      }
    } catch {}
  }, [atChapterEnd, chapter?.id]);
  const sentenceTokens = (sentence: Sentence) =>
    sentence.tokens.length
      ? sentence.tokens
      : sentence.text.split(/\s+/).filter(Boolean).map((text, position) => ({
          id: `${sentence.id}-w${position}`,
          text,
          position,
          startMs: 0,
          endMs: 0,
          confidence: 1,
        }));
  const playBrowserNarration = (
    startSentenceIndex = 0,
    startWordIndex = 0,
    session = playbackSessionRef.current,
  ) => {
    if (!chapter || !("speechSynthesis" in window))
      throw new Error("Browser speech is unavailable");
    const synth = window.speechSynthesis;
    const remainingWords = chapter.sentences
      .slice(startSentenceIndex)
      .reduce((total, sentence) => total + sentenceTokens(sentence).length, 0);
    setNarrationDuration(Math.max(1, (remainingWords / (2.25 * speedRef.current)) * 1000));
    browserSpeechActiveRef.current = true;
    setPlayerError("");

    const speakSentence = (sentenceIndex: number, wordIndex: number) => {
      if (
        session !== playbackSessionRef.current ||
        !chapter ||
        sentenceIndex >= chapter.sentences.length
      ) {
        browserSpeechActiveRef.current = false;
        setPlaying(false);
        setActiveWordId("");
        if (chapter && sentenceIndex >= chapter.sentences.length) setAtChapterEnd(true);
        return;
      }
      const tokens = sentenceTokens(chapter.sentences[sentenceIndex]).slice(wordIndex);
      const text = tokens.map((token) => token.text).join(" ");
      if (!text) {
        speakSentence(sentenceIndex + 1, 0);
        return;
      }
      const starts: number[] = [];
      let cursor = 0;
      tokens.forEach((token) => {
        starts.push(cursor);
        cursor += token.text.length + 1;
      });
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "ar-SA";
      utterance.rate = speedRef.current;
      utterance.pitch = 1;
      const arabicVoices = synth
        .getVoices()
        .filter((voice) => voice.lang.toLowerCase().startsWith("ar"));
      const arabicVoice = arabicVoices[0];
      if (arabicVoice) utterance.voice = arabicVoice;
      utterance.onstart = () => {
        if (session === playbackSessionRef.current) setPlaying(true);
      };
      utterance.onboundary = (event) => {
        if (session !== playbackSessionRef.current) return;
        let localIndex = 0;
        for (let index = 0; index < starts.length; index += 1) {
          if (starts[index] <= event.charIndex) localIndex = index;
          else break;
        }
        const token = tokens[localIndex];
        if (!token) return;
        setCurrentSentenceIndex(sentenceIndex);
        rememberReadingSpot(sentenceIndex, token.id);
        const elapsed = Math.max(0, event.elapsedTime * 1000);
        currentMsRef.current = elapsed;
        if (performance.now() - lastTimelinePaintRef.current > 200) {
          lastTimelinePaintRef.current = performance.now();
          setCurrentMs(elapsed);
        }
        if (activeWordRef.current !== token.id) {
          activeWordRef.current = token.id;
          setActiveWordId(token.id);
          revealActiveWord(token.id);
        }
      };
      utterance.onend = () => {
        if (session === playbackSessionRef.current)
          speakSentence(sentenceIndex + 1, 0);
      };
      utterance.onerror = () => {
        if (session === playbackSessionRef.current) {
          browserSpeechActiveRef.current = false;
          setPlaying(false);
          setPlayerError("تعذر تشغيل الصوت في هذا المتصفح.");
        }
      };
      synth.speak(utterance);
    };
    speakSentence(startSentenceIndex, startWordIndex);
  };
  const requestVoice = (text: string) =>
    api<VoiceResult>("/tts", {
      method: "POST",
      body: JSON.stringify({ text }),
    });
  const requestVoiceReliable = async (text: string) => {
    let lastError: unknown;
    const attempts = import.meta.env.PROD ? 1 : 3;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await requestVoice(text);
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => window.setTimeout(resolve, 700 * (attempt + 1)));
      }
    }
    throw lastError;
  };
  const buildNarrationDrafts = (startSentenceIndex = 0, startWordIndex = 0) => {
    if (!chapter) return [];
    const segments: { textParts: string[]; tokens: PreparedNarrationSegment["tokens"] }[] = [];
    let current = { textParts: [] as string[], tokens: [] as PreparedNarrationSegment["tokens"] };
    chapter.sentences.slice(Math.max(0, startSentenceIndex)).forEach((sentence, offset) => {
      const sentenceIndex = Math.max(0, startSentenceIndex) + offset;
      const tokens = sentenceTokens(sentence).slice(
        sentenceIndex === startSentenceIndex ? Math.max(0, startWordIndex) : 0,
      );
      if (!tokens.length) return;
      const text = tokens.map((token) => token.text).join(" ");
      const nextLength = current.textParts.join(" ").length + text.length + 1;
      if (current.textParts.length && nextLength > 1500) {
        segments.push(current);
        current = { textParts: [], tokens: [] };
      }
      current.textParts.push(text);
      current.tokens.push(
        ...tokens.map((token) => ({
          id: token.id,
          text: token.text,
          sentenceIndex,
        })),
      );
    });
    if (current.textParts.length) segments.push(current);
    return segments.map((segment) => ({
      text: segment.textParts.join(" "),
      tokens: segment.tokens,
    }));
  };
  const prepareChapterNarration = (
    startSentenceIndex = 0,
    startWordIndex = 0,
    session = playbackSessionRef.current,
  ) => {
    if (!chapter) return Promise.reject(new Error("chapter-not-ready"));
    const key = `${chapter.id}:${startSentenceIndex}:${startWordIndex}`;
    if (preparationRef.current?.key === key)
      return preparationRef.current.promise;
    const drafts = buildNarrationDrafts(startSentenceIndex, startWordIndex);
    const prepared: PreparedNarrationSegment[] = [];
    const loadBatch = async (batch: ReturnType<typeof buildNarrationDrafts>) => {
      const results = await Promise.all(batch.map((item) => requestVoiceReliable(item.text)));
      const loaded = batch.map((item, index) => ({
        ...item,
        result: results[index],
        boundaryTokens: alignBoundaries(results[index].boundaries, item.tokens),
      }));
      return loaded;
    };
    const promise = (async () => {
      const firstBatch = drafts.slice(0, 1);
      if (!firstBatch.length) throw new Error("narration-empty");
      prepared.push(...(await loadBatch(firstBatch)));
      const background = (async () => {
        for (let offset = 1; offset < drafts.length; offset += 1) {
          if (session !== playbackSessionRef.current) return;
          await new Promise((resolve) => window.setTimeout(resolve, 120));
          if (session !== playbackSessionRef.current) return;
          prepared.push(...(await loadBatch(drafts.slice(offset, offset + 1))));
        }
      })();
      const trackedBackground = background.finally(() => {
        if (backgroundNarrationRef.current === trackedBackground) backgroundNarrationRef.current = null;
      });
      backgroundNarrationRef.current = trackedBackground;
      return prepared;
    })();
    preparationRef.current = { key, promise };
    promise.catch(() => {
      if (preparationRef.current?.promise === promise) preparationRef.current = null;
    });
    return promise;
  };
  const playPreparedSegment = async (
    prepared: PreparedNarrationSegment[],
    segmentIndex: number,
    boundaryIndex = 0,
    session = playbackSessionRef.current,
  ) => {
    const segment = prepared[segmentIndex];
    if (!chapter || !segment || session !== playbackSessionRef.current) {
      setPlaying(false);
      return;
    }
    try {
      cancelAnimationFrame(animationRef.current);
      const audio = audioRef.current || new Audio();
      audio.onplay = null;
      audio.onpause = null;
      audio.onended = null;
      audio.ontimeupdate = null;
      audio.onerror = null;
      audio.pause();
      audio.loop = false;
      audio.muted = false;
      audio.volume = volumeRef.current;
      audio.src = segment.result.audioUrl;
      audio.preload = "auto";
      audio.defaultPlaybackRate = speedRef.current;
      audio.playbackRate = speedRef.current;
      audioRef.current = audio;
      await new Promise<void>((resolve, reject) => {
        audio.onloadedmetadata = () => {
          audio.onloadedmetadata = null;
          audio.onerror = null;
          resolve();
        };
        audio.onerror = () => {
          audio.onloadedmetadata = null;
          audio.onerror = null;
          reject(new Error("audio"));
        };
        audio.load();
      });
      if (session !== playbackSessionRef.current) {
        releaseAudio(audio);
        return;
      }
      const start = segment.result.boundaries[boundaryIndex]?.startMs || 0;
      audio.currentTime = start / 1000;
      const updateTracking = () => {
        if (session !== playbackSessionRef.current) return;
        const time = audio.currentTime * 1000;
        currentMsRef.current = time;
        const now = performance.now();
        if (now - lastTimelinePaintRef.current > 100) {
          lastTimelinePaintRef.current = now;
          setCurrentMs(time);
        }
        const activeBoundary = findActiveBoundary(segment.result.boundaries, time);
        if (activeBoundary >= 0 && activeBoundary > lastTrackedBoundaryRef.current) {
          let latestToken: { id: string; sentenceIndex: number } | null = null;
          for (
            let boundary = Math.max(0, lastTrackedBoundaryRef.current + 1);
            boundary <= activeBoundary;
            boundary += 1
          ) {
            const token = segment.boundaryTokens[boundary];
            if (!token) continue;
            latestToken = token;
            rememberReadingSpot(token.sentenceIndex, token.id);
          }
          lastTrackedBoundaryRef.current = activeBoundary;
          if (latestToken) {
            activeWordRef.current = latestToken.id;
            currentSentenceIndexRef.current = latestToken.sentenceIndex;
            setActiveWordId(latestToken.id);
            setCurrentSentenceIndex(latestToken.sentenceIndex);
            revealActiveWord(latestToken.id);
          }
        }
        if (!audio.paused && !audio.ended && !trackingFramePendingRef.current) {
          trackingFramePendingRef.current = true;
          animationRef.current = requestAnimationFrame(() => {
            trackingFramePendingRef.current = false;
            updateTracking();
          });
        }
      };
      audio.ontimeupdate = updateTracking;
      audio.onplay = () => {
        setPlayerError("");
        setPlaying(true);
        updateTracking();
      };
      audio.onpause = () => {
        cancelAnimationFrame(animationRef.current);
        trackingFramePendingRef.current = false;
        setPlaying(false);
        // No glow while paused; it re-lights when the next word is spoken.
        activeWordRef.current = "";
        setActiveWordId("");
      };
      audio.onended = async () => {
        if (session !== playbackSessionRef.current) return;
        cancelAnimationFrame(animationRef.current);
        trackingFramePendingRef.current = false;
        if (segmentIndex + 1 < prepared.length) {
          void playPreparedSegment(prepared, segmentIndex + 1, 0, session);
        } else if (backgroundNarrationRef.current) {
          setNarrationBusy(true);
          await backgroundNarrationRef.current.catch(() => {});
          setNarrationBusy(false);
          if (session !== playbackSessionRef.current) return;
          if (segmentIndex + 1 < prepared.length)
            void playPreparedSegment(prepared, segmentIndex + 1, 0, session);
          else {
            audioRef.current = null;
            setPlaying(false);
            setActiveWordId("");
            setAtChapterEnd(true);
          }
        } else {
          audioRef.current = null;
          setPlaying(false);
          setActiveWordId("");
          setAtChapterEnd(true);
        }
      };
      currentSegmentRef.current = segmentIndex;
      lastTrackedBoundaryRef.current = Math.max(-1, boundaryIndex - 1);
      const firstToken = segment.boundaryTokens[boundaryIndex];
      if (firstToken) {
        currentSentenceIndexRef.current = firstToken.sentenceIndex;
        setCurrentSentenceIndex(firstToken.sentenceIndex);
      }
      setTtsBoundaries(segment.result.boundaries);
      setNarrationDuration(segment.result.durationMs);
      setCurrentMs(start);
      await audio.play();
    } catch {
      if (session === playbackSessionRef.current) {
        setPlaying(false);
        setPlayerError("تعذر تجهيز الصوت الآن. حاول مرة أخرى.");
      }
    }
  };
  const toggleNarration = async () => {
    if (browserSpeechActiveRef.current) {
      if (window.speechSynthesis.paused) {
        window.speechSynthesis.resume();
        setPlaying(true);
      } else {
        window.speechSynthesis.pause();
        setPlaying(false);
        activeWordRef.current = "";
        setActiveWordId("");
      }
      return;
    }
    const audio = audioRef.current;
    if (audio) {
      if (audio.paused) await audio.play();
      else audio.pause();
      return;
    }
    const session = stopAllPlayback();
    primeAudioPlayback();
    setNarrationBusy(true);
    setPlayerError("");
    try {
      const startSentenceIndex = Math.min(
        Math.max(0, currentSentenceIndexRef.current),
        Math.max(0, (chapter?.sentences.length || 1) - 1),
      );
      const startWordIndex = chapter
        ? Math.max(0, sentenceTokens(chapter.sentences[startSentenceIndex]).findIndex(
          (token) => token.id === activeWordRef.current,
        ))
        : 0;
      const prepared = await prepareChapterNarration(startSentenceIndex, startWordIndex, session);
      if (session !== playbackSessionRef.current) return;
      await playPreparedSegment(prepared, 0, 0, session);
    } catch {
      if (session !== playbackSessionRef.current) return;
      try {
        playBrowserNarration(currentSentenceIndex, 0, session);
      } catch {
        setPlayerError("تعذر تشغيل الصوت الآن. حاول مرة أخرى.");
      }
    } finally {
      if (session === playbackSessionRef.current) setNarrationBusy(false);
    }
  };
  const autoNarrationStartedRef = useRef("");
  useEffect(() => {
    if (!chapter || !initialSettings.autoNarration || autoNarrationStartedRef.current === chapter.id) return;
    autoNarrationStartedRef.current = chapter.id;
    const timer = window.setTimeout(() => void toggleNarration(), 450);
    return () => window.clearTimeout(timer);
  }, [chapter?.id]);
  const speak = async (text: string) => {
    const session = stopAllPlayback();
    primeAudioPlayback();
    try {
      const result = await requestVoice(text);
      if (session !== playbackSessionRef.current) return;
      const audio = new Audio(result.audioUrl);
      audio.defaultPlaybackRate = speedRef.current;
      audio.playbackRate = speedRef.current;
      audio.volume = volumeRef.current;
      previewAudioRef.current = audio;
      audio.addEventListener("playing", () => setPlayerError(""), { once: true });
      await audio.play();
    } catch {
      if (session === playbackSessionRef.current) {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = "ar-SA";
        utterance.rate = speedRef.current;
        utterance.pitch = 1;
        utterance.onstart = () => { setPlayerError(""); setPlaying(true); };
        utterance.onend = () => setPlaying(false);
        window.speechSynthesis.speak(utterance);
        return;
      }
    }
  };
  const playToken = async (sentenceIndex: number, wordIndex: number) => {
    const session = stopAllPlayback();
    primeAudioPlayback();
    setNarrationBusy(true);
    setPlayerError("");
    try {
      const tokenId = chapter
        ? sentenceTokens(chapter.sentences[sentenceIndex])[wordIndex]?.id
        : "";
      if (!tokenId) throw new Error("token-not-found");
      activeWordRef.current = tokenId;
      currentSentenceIndexRef.current = sentenceIndex;
      setActiveWordId(tokenId);
      setCurrentSentenceIndex(sentenceIndex);
      rememberReadingSpot(sentenceIndex, tokenId);
      const prepared = await prepareChapterNarration(sentenceIndex, wordIndex, session);
      if (session !== playbackSessionRef.current || !chapter) return;
      await playPreparedSegment(prepared, 0, 0, session);
    } catch {
      if (session !== playbackSessionRef.current) {
        setPlayerError("تعذر تجهيز صوت حامد لهذه الكلمة.");
        return;
      }
      if (session === playbackSessionRef.current) {
        try {
          playBrowserNarration(sentenceIndex, wordIndex, session);
          return;
        } catch {
          setPlayerError("تعذر تشغيل هذه الكلمة الآن.");
          return;
        }
      }
      if (session === playbackSessionRef.current)
        setPlayerError("تعذر تحميل الفصل كاملًا. حاول مرة أخرى.");
    } finally {
      if (session === playbackSessionRef.current) setNarrationBusy(false);
    }
  };
  const rootChapterComments = chapterComments.filter((comment) => !comment.parentId);
  const filteredChapterComments = chapterRatingFilter
    ? rootChapterComments.filter((comment) => comment.rating === chapterRatingFilter)
    : rootChapterComments;
  const chapterAverage = weightedRating(rootChapterComments);
  const chapterReplies = (parentId: string) =>
    chapterComments.filter((comment) => comment.parentId === parentId);
  const seek = (value: number) => {
    const next = Math.max(0, Math.min(durationMs, value));
    setCurrentMs(next);
    if (audioRef.current) audioRef.current.currentTime = next / 1000;
  };
  const goToChapter = (target: { id: string; title: string; locked?: boolean } | null) => {
    if (!target) return;
    if (target.locked) {
      setLockedChapter(target);
      return;
    }
    if (target.id === chapterId) {
      setShowChapterList(false);
      return;
    }
    stopAllPlayback();
    setTransitionTitle(target.title);
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.setTimeout(() => nav(`/reader/${target.id}`), reduceMotion ? 0 : 180);
  };
  const closeIllustration = () => {
    illustrationDragRef.current = null;
    setIllustrationDragging(false);
    setIllustrationView({ scale: 1, x: 0, y: 0 });
    setOpenIllustration(null);
  };
  const changeIllustrationZoom = (amount: number) => {
    setIllustrationView((view) => ({
      ...view,
      scale: Math.max(1, Math.min(4, Number((view.scale + amount).toFixed(2)))),
    }));
  };
  const resetIllustrationView = () => setIllustrationView({ scale: 1, x: 0, y: 0 });
  useEffect(() => {
    if (openIllustration) resetIllustrationView();
  }, [openIllustration?.src]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (openIllustration) {
        if (event.key === "Escape") closeIllustration();
        if (event.key === "+" || event.key === "=") changeIllustrationZoom(.25);
        if (event.key === "-") changeIllustrationZoom(-.25);
        if (event.key === "0") resetIllustrationView();
        return;
      }
      const target = event.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (event.code === "Space") {
        event.preventDefault();
        void toggleNarration();
      }
      if (event.key.toLowerCase() === "f") setFocusMode((value) => !value);
      if (event.key === "ArrowRight") {
        event.preventDefault();
        seek(currentMsRef.current + 5000);
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        seek(currentMsRef.current - 5000);
      }
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        // Continuous rAF scrolling: holding the key stays smooth instead of
        // queueing competing smooth-scroll animations.
        scrollHoldRef.current = event.key === "ArrowUp" ? -1 : 1;
        if (!scrollAnimRef.current) {
          const step = () => {
            const container = readerBodyRef.current;
            if (!container || !scrollHoldRef.current) {
              scrollAnimRef.current = 0;
              return;
            }
            container.scrollTop += scrollHoldRef.current * 14;
            scrollAnimRef.current = requestAnimationFrame(step);
          };
          scrollAnimRef.current = requestAnimationFrame(step);
        }
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        scrollHoldRef.current = 0;
        cancelAnimationFrame(scrollAnimRef.current);
        scrollAnimRef.current = 0;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  });
  const summarize = async (s: Sentence) => {
    setActiveSentence(s);
    setSummaryBusy(true);
    setSummary("");
    try {
      const r = await api<{ summary: string }>(`/sentences/${s.id}/summary`, {
        method: "POST",
      });
      setSummary(r.summary);
    } catch (e) {
      setSummary((e as Error).message);
    } finally {
      setSummaryBusy(false);
    }
  };
  const bookmark = async (s: Sentence) => {
    const alreadySaved = savedSentenceIds.includes(s.id);
    const next = alreadySaved
      ? savedSentenceIds.filter((id) => id !== s.id)
      : [...savedSentenceIds, s.id];
    setSavedSentenceIds(next);
    localStorage.setItem(`rethox-bookmarks-${chapterId}`, JSON.stringify(next));
    localStorage.setItem(`rethox-sentence-${chapterId}`, String(s.position - 1));
    setSaveNotice(alreadySaved ? "أزيلت العلامة" : "تم حفظ موضعك داخل الفصل");
    window.setTimeout(() => setSaveNotice(""), 1800);
    if (user && chapter)
      setBookmark({
        bookId: chapter.bookId,
        chapterId: chapter.id,
        sentenceId: s.id,
        saved: !alreadySaved,
      }).catch(() => {});
  };
  const submitChapterComment = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!chapterId) return;
    if (!user) {
      nav(registerWithReturn());
      return;
    }
    try {
      const comment = await saveChapterComment({
        chapterId,
        rating: chapterRating,
        body: chapterCommentBody,
        spoiler: chapterCommentSpoiler,
      });
      setChapterComments((current) => [
        comment,
        ...current.filter((item) => item.id !== comment.id),
      ]);
      setChapterCommentBody("");
      setChapterCommentSpoiler(false);
      setChapterCommentMessage("تم نشر رأيك في الفصل");
    } catch (error) {
      setChapterCommentMessage((error as Error).message);
    }
  };
  const submitChapterReply = async (parentId: string) => {
    if (!chapterId) return;
    if (!user) {
      nav(registerWithReturn());
      return;
    }
    const body = (replyBodies[parentId] || "").trim();
    if (!body) return;
    try {
      const reply = await saveChapterComment({
        chapterId,
        parentId,
        body,
        spoiler: false,
      });
      setChapterComments((current) => [reply, ...current]);
      setReplyBodies((current) => ({ ...current, [parentId]: "" }));
    } catch (error) {
      setChapterCommentMessage((error as Error).message);
    }
  };
  const removeChapterComment = async (comment: ChapterComment) => {
    if (!chapterId || !user || user.id !== comment.user.id || !window.confirm("حذف تعليقك؟")) return;
    try {
      await deleteChapterComment(chapterId, comment.id);
      setChapterComments((current) => current.filter((item) => item.id !== comment.id && item.parentId !== comment.id));
    } catch (error) {
      setChapterCommentMessage((error as Error).message);
    }
  };
  const normalizeSearch = (text: string) =>
    text
      .normalize("NFKD")
      .replace(/[\u064B-\u065F\u0670]/g, "")
      .replace(/[إأآ]/g, "ا")
      .replace(/ى/g, "ي")
      .replace(/ة/g, "ه")
      .replace(/[^\p{L}\p{N}\s]/gu, "")
      .toLowerCase();
  const searchMatches = useMemo(() => {
    if (!chapter) return [] as { sentenceIndex: number; tokenIds: string[] }[];
    const queryWords = normalizeSearch(searchQuery).split(/\s+/).filter(Boolean);
    if (!queryWords.length) return [];
    const matches: { sentenceIndex: number; tokenIds: string[] }[] = [];
    chapter.sentences.forEach((sentence, sentenceIndex) => {
      const tokens = sentenceTokens(sentence);
      const normalized = tokens.map((token) => normalizeSearch(token.text).replace(/\s+/g, ""));
      for (let start = 0; start + queryWords.length <= tokens.length; start += 1) {
        let matched = true;
        for (let offset = 0; offset < queryWords.length; offset += 1) {
          if (!normalized[start + offset].includes(queryWords[offset])) {
            matched = false;
            break;
          }
        }
        if (matched)
          matches.push({
            sentenceIndex,
            tokenIds: tokens.slice(start, start + queryWords.length).map((token) => token.id),
          });
      }
    });
    return matches;
  }, [chapter, searchQuery]);
  const searchHitTokens = useMemo(() => {
    const map = new Map<string, "hit" | "current">();
    searchMatches.forEach((match, index) =>
      match.tokenIds.forEach((id) => {
        if (index === activeMatchIndex) map.set(id, "current");
        else if (map.get(id) !== "current") map.set(id, "hit");
      }),
    );
    return map;
  }, [searchMatches, activeMatchIndex]);
  useEffect(() => setActiveMatchIndex(0), [searchQuery, chapter?.id]);
  const goToMatch = (index: number) => {
    if (!searchMatches.length) return;
    const next = (index + searchMatches.length) % searchMatches.length;
    setActiveMatchIndex(next);
    document
      .querySelector(`[data-word-id="${searchMatches[next].tokenIds[0]}"]`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  const dragRailTo = (clientY: number) => {
    const rail = railRef.current;
    const container = readerBodyRef.current;
    if (!rail || !container) return;
    const rect = rail.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
    container.scrollTo({ top: ratio * (container.scrollHeight - container.clientHeight) });
  };
  const savedSentences = chapter
    ? chapter.sentences.filter((sentence) => savedSentenceIds.includes(sentence.id))
    : [];
  const jumpToSentence = (sentence: Sentence) => {
    setActiveSentence(sentence);
    const index = chapter?.sentences.findIndex((item) => item.id === sentence.id) ?? -1;
    if (index >= 0) {
      currentSentenceIndexRef.current = index;
      setCurrentSentenceIndex(index);
      rememberReadingSpot(index, "");
      setSectionTargetId(sentence.id);
      window.clearTimeout(sectionHighlightTimerRef.current);
      window.requestAnimationFrame(() => {
        readerBodyRef.current
          ?.querySelector(`[data-sentence-index="${index}"]`)
          ?.scrollIntoView({
            block: "center",
            behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
          });
      });
      sectionHighlightTimerRef.current = window.setTimeout(() => setSectionTargetId(""), 850);
    }
  };
  const jumpToSection = (sentenceId: string) => {
    const sentence = chapter?.sentences.find((item) => item.id === sentenceId);
    setShowChapterList(false);
    if (sentence) window.requestAnimationFrame(() => jumpToSentence(sentence));
  };
  if (!chapter || !book) return <Loading dark />;
  let completedChapters: string[] = [];
  try {
    completedChapters = JSON.parse(
      localStorage.getItem("rethox-completed-chapters") || "[]",
    );
  } catch {}
  const chapterProgressPercentage = chapterReadingPercentage(
    chapter,
    currentSentenceIndex,
    activeWordId,
    atChapterEnd || completedChapters.includes(chapter.id),
  );
  const chapterIllustration = (
    illustration: NonNullable<Chapter["illustrations"]>[number],
    inline: boolean,
  ) => (
    <figure
      className={`chapter-opening-illustration${inline ? " chapter-inline-illustration" : ""}`}
      key={illustration.src}
    >
      <button
        type="button"
        onClick={() => setOpenIllustration(illustration)}
        aria-label={`تكبير الصورة: ${illustration.alt}`}
      >
        <img
          src={illustration.src}
          alt={illustration.alt}
          loading="lazy"
          decoding="async"
        />
        <span>اضغط للتكبير</span>
      </button>
    </figure>
  );
  return (
    <div className={`reader ${focusMode ? "focus-mode" : ""}`}>
      {transitionTitle && (
        <div className="chapter-transition" aria-live="polite">
          <span>نفتح الصفحة التالية</span>
          <h2>{transitionTitle}</h2>
          <i />
        </div>
      )}
      <header className="reader-head">
        <button onClick={() => nav(`/book/${book.slug}`)}>
          <X />
        </button>
        <div>
          <b>{book.title}</b>
          <small>
            {chapter.title} · {book.contentUnitLabel || "فصل"} {chapter.position} من {chapterList.length || 1}
          </small>
        </div>
        <div className="reader-progress">
          <span
            style={{
              width: `${chapterProgressPercentage}%`,
            }}
          ></span>
        </div>
        <button
          onClick={() => document.querySelector<HTMLButtonElement>(".theme-fab")?.click()}
        >
          <Moon />
        </button>
      </header>
      <main className="reader-body" ref={readerBodyRef}>
        <aside className={`reader-tools ${showChapterList ? "index-open" : ""}`}>
          <button onClick={() => setShowChapterList((value) => !value)} title={`فهرس ${book.contentUnitLabelPlural || "الفصول"}`}>
            <List />
          </button>
          <button onClick={() => setFocusMode((value) => !value)} title="وضع التركيز">
            {focusMode ? <Minimize2 /> : <Maximize2 />}
          </button>
          <button onClick={() => setFontSize((v) => Math.min(46, v + 2))}>
            + أ
          </button>
          <button onClick={() => setFontSize((v) => Math.max(22, v - 2))}>
            - أ
          </button>
          <button
            className={
              activeSentence && savedSentenceIds.includes(activeSentence.id)
                ? "saved"
                : ""
            }
            onClick={() => activeSentence && bookmark(activeSentence)}
            title="حفظ موضع القراءة هنا"
            aria-label="حفظ موضع القراءة هنا"
          >
            <Bookmark
              fill={
                activeSentence && savedSentenceIds.includes(activeSentence.id)
                  ? "currentColor"
                  : "none"
              }
            />
          </button>
          <button
            className={showSavedList ? "saved" : ""}
            onClick={() => setShowSavedList((value) => !value)}
            title="قائمة المحفوظات"
            aria-label="قائمة المحفوظات"
          >
            <Library />
            {!!savedSentences.length && <em className="saved-count">{savedSentences.length}</em>}
          </button>
          <button
            className={showSearch ? "saved" : ""}
            onClick={() => setShowSearch((value) => !value)}
            title={`البحث في ${book.contentUnitLabel || "الفصل"}`}
            aria-label={`البحث في ${book.contentUnitLabel || "الفصل"}`}
          >
            <Search />
          </button>
          <button
            onClick={() => user ? setShowReport(true) : nav(registerWithReturn())}
            title="الإبلاغ عن خطأ في النص"
            aria-label="الإبلاغ عن خطأ في النص"
          >
            <Flag />
          </button>
        </aside>
        <aside className={`reader-index saved-panel ${showSavedList ? "open" : ""}`}>
          <div>
            <span>محفوظاتك في هذا {book.contentUnitLabel || "الفصل"}</span>
            <button onClick={() => setShowSavedList(false)}><X /></button>
          </div>
          {savedSentences.length ? (
            <nav>
              {savedSentences.map((sentence) => (
                <button key={sentence.id} onClick={() => jumpToSentence(sentence)}>
                  <i><Bookmark size={13} /></i>
                  <span dir="auto">
                    {sentence.text.split(/\s+/).slice(0, 10).join(" ")}
                    {sentence.text.split(/\s+/).length > 10 ? "…" : ""}
                  </span>
                </button>
              ))}
            </nav>
          ) : (
            <p className="saved-empty">لا محفوظات بعد — اضغط أيقونة الحفظ بجانب أي فقرة.</p>
          )}
        </aside>
        <aside className={`reader-index ${showChapterList ? "open" : ""}`}>
          <div>
            <span>{chapter.sections?.length ? "فهرس المجلد والرواية" : "فهرس الرواية"}</span>
            <button onClick={() => setShowChapterList(false)}><X /></button>
          </div>
          <nav>
            {!!chapter.sections?.length && (
              <>
                <b className="reader-index-group">أقسام {chapter.title}</b>
                {chapter.sections.map((section) => (
                  <button key={section.id} className="reader-section-link" onClick={() => jumpToSection(section.sentenceId)}>
                    <i>{String(section.position).padStart(2, "0")}</i>
                    <span>{section.title}</span>
                  </button>
                ))}
                <b className="reader-index-group">مجلدات الرواية</b>
              </>
            )}
            {chapterList.map((item) => (
              <button
                key={item.id}
                className={`${item.id === chapter.id ? "current" : ""} ${completedChapters.includes(item.id) ? "completed" : ""}`}
                onClick={() => goToChapter(item)}
              >
                <i>{completedChapters.includes(item.id) ? <Check /> : item.position}</i>
                <span>{item.title}</span>
              </button>
            ))}
          </nav>
        </aside>
        {showSearch && (
          <div className="chapter-search" role="search">
            <Search size={15} />
            <input
              dir="auto"
              autoFocus
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  goToMatch(activeMatchIndex + (event.shiftKey ? -1 : 1));
                }
                if (event.key === "Escape") setShowSearch(false);
              }}
              placeholder={`ابحث عن كلمة أو جملة في ${book.contentUnitLabel || "الفصل"}...`}
            />
            <span className="search-count">
              {searchQuery.trim()
                ? searchMatches.length
                  ? `${activeMatchIndex + 1} من ${searchMatches.length}`
                  : "لا نتائج"
                : ""}
            </span>
            <button onClick={() => goToMatch(activeMatchIndex - 1)} disabled={!searchMatches.length} aria-label="النتيجة السابقة"><ArrowUp size={15} /></button>
            <button onClick={() => goToMatch(activeMatchIndex + 1)} disabled={!searchMatches.length} aria-label="النتيجة التالية"><ArrowDown size={15} /></button>
            <button onClick={() => { setShowSearch(false); setSearchQuery(""); }} aria-label="إغلاق البحث"><X size={15} /></button>
          </div>
        )}
        <div
          className="scroll-rail"
          ref={railRef}
          onPointerDown={(event) => {
            railDraggingRef.current = true;
            event.currentTarget.setPointerCapture(event.pointerId);
            dragRailTo(event.clientY);
          }}
          onPointerMove={(event) => {
            if (railDraggingRef.current) dragRailTo(event.clientY);
          }}
          onPointerUp={() => (railDraggingRef.current = false)}
          onPointerCancel={() => (railDraggingRef.current = false)}
          aria-hidden="true"
        >
          <i style={{ top: `calc(${(scrollRatio * 100).toFixed(2)}% - ${(scrollRatio * 46).toFixed(1)}px)` }} />
        </div>
        <article
          style={{ fontSize, lineHeight }}
          onCopy={(event) => event.preventDefault()}
          onCut={(event) => event.preventDefault()}
        >
          <nav className="reader-chapter-nav reader-chapter-jump" aria-label="تنقل سريع بين الفصول">
            {chapterNav.previous ? (
              <button onClick={() => goToChapter(chapterNav.previous)}>
                <ArrowLeft size={15} />
                <span>{book.contentUnitLabel || "الفصل"} السابق</span>
                <b>{chapterNav.previous.title}</b>
              </button>
            ) : <span />}
            {chapterNav.next ? (
              <button onClick={() => goToChapter(chapterNav.next)}>
                <span>{book.contentUnitLabel || "الفصل"} التالي</span>
                <b>{chapterNav.next.title}</b>
                <ChevronLeft size={15} />
              </button>
            ) : <span />}
          </nav>
          <span className="chapter-label">{chapter.title}</span>
          {chapter.illustrations
            ?.filter((illustration) => !illustration.afterSentenceId)
            .map((illustration) => chapterIllustration(illustration, false))}
          {chapter.sentences.map((s, sentenceIndex) => (
            <Fragment key={s.id}>
              <p
              data-sentence-index={sentenceIndex}
              data-sentence-id={s.id}
              className={[
                savedSentenceIds.includes(s.id) ? "saved-paragraph" : "",
                sectionTargetId === s.id ? "section-target" : "",
              ].filter(Boolean).join(" ")}
              onMouseEnter={() => setActiveSentence(s)}
            >
              {sentenceTokens(s).map((token, wordIndex) => (
                <button
                  key={token.id}
                  data-word-id={token.id}
                  onClick={() => playToken(sentenceIndex, wordIndex)}
                  className={[
                    activeWordId === token.id ? "active-word" : "",
                    searchHitTokens.get(token.id) === "current"
                      ? "search-hit current-hit"
                      : searchHitTokens.has(token.id)
                        ? "search-hit"
                        : "",
                  ].filter(Boolean).join(" ")}
                >
                  {token.text}{" "}
                </button>
              ))}
              <span className="sentence-actions">
                <button onClick={() => speak(s.text)} aria-label="اقرأ الجملة">
                  <Headphones />
                </button>
                <button onClick={() => summarize(s)} aria-label="لخص الجملة">
                  <Sparkles />
                </button>
                <button onClick={() => bookmark(s)} aria-label="احفظ موضع القراءة">
                  <Bookmark fill={savedSentenceIds.includes(s.id) ? "currentColor" : "none"} />
                </button>
              </span>
              </p>
              {chapter.illustrations
                ?.filter((illustration) => illustration.afterSentenceId === s.id)
                .map((illustration) => chapterIllustration(illustration, true))}
            </Fragment>
          ))}
          <section className="chapter-community">
            <div className="chapter-community-head">
              <div>
                <span className="kicker">مجلس القرّاء</span>
                <h2>ما رأيك في هذا {book.contentUnitLabel || "الفصل"}؟</h2>
              </div>
              <span>{rootChapterComments.length} تعليق</span>
              <span className="rating-summary">
                {"\u2605"} {rootChapterComments.length ? chapterAverage.toFixed(1) : "لم يُقيّم بعد"}
              </span>
            </div>
            <form onSubmit={submitChapterComment}>
              <div className="rating-picker">
                {[1, 2, 3, 4, 5].map((star) => (
                  <button
                    type="button"
                    key={star}
                    className={chapterRating >= star ? "active" : ""}
                    onClick={() => setChapterRating(star)}
                  >{chapterRating >= star ? "★" : "☆"}</button>
                ))}
              </div>
              <textarea
                dir="auto"
                value={chapterCommentBody}
                onChange={(event) => setChapterCommentBody(event.target.value)}
                placeholder="اكتب تعليقك إذا حبيت — التقييم وحده يكفي."
                maxLength={1200}
              />
              <div className="comment-actions">
                <label className="spoiler-toggle">
                  <input
                    type="checkbox"
                    checked={chapterCommentSpoiler}
                    onChange={(event) => setChapterCommentSpoiler(event.target.checked)}
                  /> يحتوي حرقًا
                </label>
                <button className="btn primary">نشر التعليق</button>
              </div>
              {chapterCommentMessage && <small>{chapterCommentMessage}</small>}
            </form>
            <AuthPrompt open={showAuthPrompt} onClose={() => setShowAuthPrompt(false)} />
            {!!chapterComments.length && (
              <div className="rating-filter" aria-label={`تصفية تعليقات ${book.contentUnitLabel || "الفصل"}`}>
                <button type="button" className={!chapterRatingFilter ? "active" : ""} onClick={() => setChapterRatingFilter(0)}>الكل</button>
                {[5, 4, 3, 2, 1].map((star) => (
                  <button type="button" key={star} className={chapterRatingFilter === star ? "active" : ""} onClick={() => setChapterRatingFilter(star)}>
                    {star} ★
                  </button>
                ))}
              </div>
            )}
            <div className="community-list">
              {filteredChapterComments.map((comment) => (
                <article key={comment.id}>
                  <header>
                    <div className="community-author">
                      <CommunityAvatar name={comment.user.name} src={comment.user.avatarUrl} />
                      <div className="community-author-copy">
                        <b dir="auto">{comment.user.name}</b>
                        <small><time dateTime={comment.createdAt}>{formatDateTime(comment.createdAt)}</time></small>
                      </div>
                    </div>
                    <div className="community-tools">
                      <span className="rating-stars">{"\u2605".repeat(comment.rating)}{"\u2606".repeat(5 - comment.rating)}</span>
                      {user?.id === comment.user.id && (
                        <button className="comment-delete" type="button" onClick={() => void removeChapterComment(comment)} aria-label="حذف تعليقي">
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  </header>
                  {comment.body && (comment.spoiler ? <SpoilerCurtain text={comment.body} /> : <p dir="auto">{comment.body}</p>)}
                  <div className="comment-replies">
                    {chapterReplies(comment.id).map((reply) => (
                      <div className="comment-reply" key={reply.id}>
                        <div className="reply-author">
                          <CommunityAvatar name={reply.user.name} src={reply.user.avatarUrl} />
                          <div>
                            <b dir="auto">{reply.user.name}</b>
                            <small><time dateTime={reply.createdAt}>{formatDateTime(reply.createdAt)}</time></small>
                          </div>
                        </div>
                        <div className="reply-body">
                          <p dir="auto">{reply.body}</p>
                          {user?.id === reply.user.id && (
                            <button className="comment-delete" type="button" onClick={() => void removeChapterComment(reply)} aria-label="حذف ردي">
                              <Trash2 size={13} />
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                    <form
                      className="reply-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void submitChapterReply(comment.id);
                      }}
                    >
                      <input
                        dir="auto"
                        value={replyBodies[comment.id] || ""}
                        onChange={(event) => setReplyBodies((current) => ({ ...current, [comment.id]: event.target.value }))}
                        placeholder="اكتب ردًا سريعًا..."
                      />
                      <button type="submit">رد</button>
                    </form>
                  </div>
                </article>
              ))}
            </div>
          </section>
          <nav className={`reader-chapter-nav ${atChapterEnd ? "reached-end" : ""}`} aria-label={`التنقل بين ${book.contentUnitLabelPlural || "الفصول"}`}>
            {chapterNav.previous ? (
              <button onClick={() => goToChapter(chapterNav.previous)}>
                <ArrowLeft size={15} />
                <span>{book.contentUnitLabel || "الفصل"} السابق</span>
                <b>{chapterNav.previous.title}</b>
              </button>
            ) : (
              <span />
            )}
            {chapterNav.next && (
              <button className="next-chapter" onClick={() => goToChapter(chapterNav.next)}>
                <span>{atChapterEnd ? "جاهز؟ تابع الرحلة" : `${book.contentUnitLabel || "الفصل"} التالي`}</span>
                <b>{chapterNav.next.title}</b>
                <small>نحو {Math.max(1, Math.ceil((chapterNav.next.sentenceCount || 1) / 3))} دقائق قراءة</small>
                <ChevronLeft size={15} />
              </button>
            )}
          </nav>
        </article>
        {(summaryBusy || summary) && (
          <aside className="summary-box">
            <button
              onClick={() => {
                setSummary("");
                setSummaryBusy(false);
              }}
            >
              <X />
            </button>
            <span>
              <Sparkles />
              خلاصة ذكية
            </span>
            <p>{summaryBusy ? "نرتب الفكرة في سطر..." : summary}</p>
            <small>الخلاصة مساعدة للقراءة؛ ارجع للنص عند الحاجة.</small>
          </aside>
        )}
        {showScrollTop && (
          <button
            className="scroll-top"
            onClick={() => readerBodyRef.current?.scrollTo({ top: 0, behavior: "smooth" })}
            aria-label={`العودة إلى أعلى ${book.contentUnitLabel || "الفصل"}`}
          >
            <ArrowUp />
          </button>
        )}
      </main>
      {saveNotice && (
        <div className="save-toast" role="status">
          <i><Check size={15} /></i>
          <span>{saveNotice}</span>
        </div>
      )}
      {showReport && (
        <div className="report-overlay" role="dialog" aria-modal="true" aria-label="الإبلاغ عن خطأ">
          <form onSubmit={async (event) => {
            event.preventDefault();
            try {
              await api("/reports", {
                method: "POST",
                body: JSON.stringify({
                  bookId: book.id,
                  chapterId: chapter.id,
                  sentenceId: activeSentence?.id,
                  message: reportText,
                }),
              });
              setReportNotice("وصل البلاغ، شكرًا لمساعدتك");
              setReportText("");
              window.setTimeout(() => { setShowReport(false); setReportNotice(""); }, 1100);
            } catch (error) {
              setReportNotice((error as Error).message);
            }
          }}>
            <button type="button" className="report-close" onClick={() => setShowReport(false)}><X /></button>
            <span className="kicker">ملاحظة للقائمين على النص</span>
            <h2>أبلغ عن خطأ</h2>
            <p>سنرفق {book.contentUnitLabel || "الفصل"} وموضع القراءة تلقائيًا. اكتب المشكلة باختصار.</p>
            {activeSentence && <blockquote dir="auto">{activeSentence.text}</blockquote>}
            <textarea value={reportText} onChange={(event) => setReportText(event.target.value)} minLength={3} maxLength={500} required placeholder="مثال: كلمة ناقصة، ترتيب غير صحيح، أو خطأ في النطق..." />
            {reportNotice && <small>{reportNotice}</small>}
            <button className="btn primary" type="submit"><Flag size={15} /> إرسال البلاغ</button>
          </form>
        </div>
      )}
      <footer className="player">
        {playerError && (
          <p className="player-error" role="status">
            {playerError}
          </p>
        )}
        <div className="player-controls">
          <button className="skip" onClick={() => seek(currentMs - 5000)} aria-label="إرجاع 5 ثوانٍ">
            <RotateCcw />
            <b>5</b>
          </button>
          <button
            className="main-play"
            onClick={toggleNarration}
            disabled={narrationBusy}
            aria-label={
              narrationBusy
                ? `جاري تحميل ${book.contentUnitLabel || "الفصل"} كاملًا`
                : playing
                  ? "إيقاف"
                  : "تشغيل"
            }
          >
            {narrationBusy ? (
              <span className="audio-loader" />
            ) : playing ? (
              <Pause fill="currentColor" />
            ) : (
              <Play fill="currentColor" />
            )}
          </button>
          <button className="skip" onClick={() => seek(currentMs + 5000)} aria-label="تقديم 5 ثوانٍ">
            <RotateCw />
            <b>5</b>
          </button>
        </div>
        <div className="timeline">
          <span>{formatTime(currentMs)}</span>
          <input
            type="range"
            min="0"
            max={durationMs}
            value={Math.min(currentMs, durationMs)}
            onChange={(e) => seek(Number(e.target.value))}
            style={{ "--fill": `${Math.min(100, (currentMs / durationMs) * 100).toFixed(2)}%` } as CSSProperties}
            aria-label="شريط التقدم"
          />
          <span>{formatTime(durationMs)}</span>
        </div>
        <div className="speech-controls">
          <div className="volume-control">
            <button type="button" aria-label="مستوى الصوت"><Volume2 size={17} /></button>
            <div className="volume-popover">
              <input
                type="range"
                min="0"
                max="100"
                value={Math.round(volume * 100)}
                onChange={(event) => setVolume(Number(event.target.value) / 100)}
                aria-label="تغيير مستوى الصوت"
              />
              <small>{Math.round(volume * 100)}%</small>
            </div>
          </div>
          <label>
            السرعة
            <select
              value={speed}
              onChange={(e) => applyPlaybackSpeed(Number(e.target.value))}
            >
              <option value="0.5">0.5×</option>
              <option value="0.75">0.75×</option>
              <option value="1">1×</option>
              <option value="1.25">1.25×</option>
              <option value="1.5">1.5×</option>
              <option value="2">2×</option>
              <option value="2.5">2.5×</option>
              <option value="3">3×</option>
              <option value="4">4×</option>
            </select>
          </label>
        </div>
      </footer>
      {openIllustration && (
        <div
          className="illustration-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={openIllustration.alt}
          onClick={closeIllustration}
        >
          <button
            className="illustration-lightbox-close"
            type="button"
            onClick={closeIllustration}
            aria-label="إغلاق الصورة"
          >
            <X />
          </button>
          <div className="illustration-lightbox-tools" onClick={(event) => event.stopPropagation()}>
            <button type="button" onClick={() => changeIllustrationZoom(-.25)} aria-label="تصغير الصورة">−</button>
            <button type="button" onClick={resetIllustrationView} aria-label="إعادة ضبط الصورة">{Math.round(illustrationView.scale * 100)}%</button>
            <button type="button" onClick={() => changeIllustrationZoom(.25)} aria-label="تكبير الصورة">+</button>
          </div>
          <div
            className={`illustration-lightbox-stage${illustrationDragging ? " is-dragging" : ""}`}
            onClick={(event) => event.stopPropagation()}
            onWheel={(event) => {
              event.preventDefault();
              changeIllustrationZoom(event.deltaY < 0 ? .2 : -.2);
            }}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              illustrationDragRef.current = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                originX: illustrationView.x,
                originY: illustrationView.y,
              };
              setIllustrationDragging(true);
            }}
            onPointerMove={(event) => {
              const drag = illustrationDragRef.current;
              if (!drag || drag.pointerId !== event.pointerId) return;
              setIllustrationView((view) => ({
                ...view,
                x: drag.originX + event.clientX - drag.startX,
                y: drag.originY + event.clientY - drag.startY,
              }));
            }}
            onPointerUp={(event) => {
              if (illustrationDragRef.current?.pointerId !== event.pointerId) return;
              illustrationDragRef.current = null;
              setIllustrationDragging(false);
            }}
            onPointerCancel={() => {
              illustrationDragRef.current = null;
              setIllustrationDragging(false);
            }}
          >
            <img
              src={openIllustration.src}
              alt={openIllustration.alt}
              draggable={false}
              style={{ transform: `translate3d(${illustrationView.x}px, ${illustrationView.y}px, 0) scale(${illustrationView.scale})` }}
            />
          </div>
        </div>
      )}
      <LockedChapterPrompt book={book} chapter={lockedChapter} onClose={() => setLockedChapter(null)} />
    </div>
  );
}
type AdminCatalogBook = {
  id: string;
  title: string;
  author: string;
  synopsis: string;
  slug: string;
  priceMinor: number;
  status: "PUBLISHED" | "DRAFT";
  coverUrl?: string;
  contentUnitLabel?: string;
  contentUnitLabelPlural?: string;
  chapters: { id: string; title: string; position: number; illustrationCount: number }[];
};
type AdminChapterDetails = {
  id: string;
  title: string;
  position: number;
  illustrations: NonNullable<Chapter["illustrations"]>;
  sentences: { id: string; position: number; text: string }[];
};
type AdminAuditLog = {
  id: string;
  user_id?: string;
  userId?: string;
  action: string;
  entity_type?: string;
  entity_id?: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
  createdAt?: string;
};

function AdminPage() {
  const { user, ready } = useAuth();
  const [overview, setOverview] = useState<any>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [reports, setReports] = useState<ContentReport[]>([]);
  const [backups, setBackups] = useState<any[]>([]);
  const [catalog, setCatalog] = useState<AdminCatalogBook[]>([]);
  const [selectedBookId, setSelectedBookId] = useState("");
  const [selectedChapterId, setSelectedChapterId] = useState("");
  const [chapterDetails, setChapterDetails] = useState<AdminChapterDetails | null>(null);
  const [auditLogs, setAuditLogs] = useState<AdminAuditLog[]>([]);
  const [contentBusy, setContentBusy] = useState(false);
  const [backupBusy, setBackupBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (user?.role === "ADMIN")
      Promise.all([
        api<any>("/admin/overview"),
        api<{ users: User[] }>("/admin/users"),
        api<{ reports: ContentReport[] }>("/admin/reports"),
        api<{ backups: any[] }>("/admin/backups"),
        api<{ books: AdminCatalogBook[] }>("/admin/catalog"),
        api<{ logs: AdminAuditLog[] }>("/admin/audit-logs"),
      ]).then(([o, u, reportData, backupData, catalogData, auditData]) => {
        setOverview(o);
        setUsers(u.users);
        setReports(reportData.reports);
        setBackups(backupData.backups);
        setCatalog(catalogData.books);
        setAuditLogs(auditData.logs);
        const firstBook = catalogData.books[0];
        setSelectedBookId((current) => current || firstBook?.id || "");
        setSelectedChapterId((current) => current || firstBook?.chapters[0]?.id || "");
      }).catch((error) => setMessage((error as Error).message));
  }, [user]);
  useEffect(() => {
    if (!selectedChapterId) {
      setChapterDetails(null);
      return;
    }
    api<{ chapter: AdminChapterDetails }>(`/admin/chapters/${selectedChapterId}`)
      .then((result) => setChapterDetails(result.chapter))
      .catch((error) => setMessage((error as Error).message));
  }, [selectedChapterId]);
  if (!ready) return <Loading />;
  if (!user) return <Navigate to="/login" />;
  if (user.role !== "ADMIN") return <Navigate to="/account" />;
  const selectedBook = catalog.find((book) => book.id === selectedBookId) || null;
  const selectedContentUnitLabel = selectedBook?.contentUnitLabel || "فصل";
  const reloadChapter = async () => {
    if (!selectedChapterId) return;
    const result = await api<{ chapter: AdminChapterDetails }>(`/admin/chapters/${selectedChapterId}`);
    setChapterDetails(result.chapter);
    setCatalog((books) => books.map((book) => ({
      ...book,
      chapters: book.chapters.map((chapter) => chapter.id === selectedChapterId
        ? { ...chapter, illustrationCount: result.chapter.illustrations.length }
        : chapter),
    })));
  };
  const reloadAudit = async () => {
    const result = await api<{ logs: AdminAuditLog[] }>("/admin/audit-logs");
    setAuditLogs(result.logs);
  };
  const create = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      await api("/admin/books", {
        method: "POST",
        body: JSON.stringify({
          title: f.get("title"),
          author: f.get("author"),
          slug: f.get("slug"),
          synopsis: f.get("synopsis"),
          priceMinor: Number(f.get("price")) * 100,
          genre: f.get("genre"),
          tags: ["جديد"],
          coverTheme: "indigo",
        }),
      });
      setMessage("تم إنشاء مسودة الكتاب");
      e.currentTarget.reset();
      const result = await api<{ books: AdminCatalogBook[] }>("/admin/catalog");
      setCatalog(result.books);
      await reloadAudit();
    } catch (e) {
      setMessage((e as Error).message);
    }
  };
  const uploadIllustration = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!chapterDetails) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    const file = fields.get("image");
    if (!(file instanceof File) || !file.size) return setMessage("اختر صورة أولًا");
    setContentBusy(true);
    setMessage("");
    try {
      const query = new URLSearchParams({ alt: String(fields.get("alt") || "") });
      const afterSentenceId = String(fields.get("afterSentenceId") || "");
      if (afterSentenceId) query.set("afterSentenceId", afterSentenceId);
      await api(`/admin/chapters/${chapterDetails.id}/illustrations?${query}`, {
        method: "POST",
        headers: { "content-type": file.type },
        body: file,
      });
      form.reset();
      await Promise.all([reloadChapter(), reloadAudit()]);
      setMessage("تم رفع الصورة وحفظ موضعها في قاعدة البيانات");
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setContentBusy(false);
    }
  };
  const editIllustration = async (event: FormEvent<HTMLFormElement>, illustrationId: string) => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    setContentBusy(true);
    try {
      await api(`/admin/chapters/${selectedChapterId}/illustrations/${illustrationId}`, {
        method: "PATCH",
        body: JSON.stringify({
          alt: String(fields.get("alt") || ""),
          afterSentenceId: String(fields.get("afterSentenceId") || "") || null,
        }),
      });
      await Promise.all([reloadChapter(), reloadAudit()]);
      setMessage("تم حفظ وصف الصورة وموضعها");
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setContentBusy(false);
    }
  };
  const replaceIllustration = async (event: FormEvent<HTMLFormElement>, illustrationId: string) => {
    event.preventDefault();
    const form = event.currentTarget;
    const file = new FormData(form).get("replacement");
    if (!(file instanceof File) || !file.size) return setMessage("اختر الصورة البديلة أولًا");
    setContentBusy(true);
    try {
      await api(`/admin/chapters/${selectedChapterId}/illustrations/${illustrationId}/file`, {
        method: "PUT",
        headers: { "content-type": file.type },
        body: file,
      });
      form.reset();
      await Promise.all([reloadChapter(), reloadAudit()]);
      setMessage("تم استبدال ملف الصورة فعليًا");
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setContentBusy(false);
    }
  };
  return (
    <section className="admin-page wrap">
      <div className="page-head">
        <span>ADMIN CONSOLE</span>
        <h1>لوحة الإدارة</h1>
        <p>تحكم كامل بالمحتوى والصور والمستخدمين مع حفظ دائم وسجل لكل تغيير.</p>
      </div>
      {overview && (
        <div className="admin-stats">
          <div>
            <BookOpen />
            <b>{overview.counts.books}</b>
            <span>الكتب</span>
          </div>
          <div>
            <UserRound />
            <b>{overview.counts.users}</b>
            <span>المستخدمون</span>
          </div>
          <div>
            <ShoppingBag />
            <b>{overview.counts.orders}</b>
            <span>الطلبات</span>
          </div>
          <div>
            <Flag />
            <b>{overview.counts.openReports}</b>
            <span>بلاغات مفتوحة</span>
          </div>
          <div>
            <Sparkles />
            <b>{overview.counts.reviews}</b>
            <span>مشاركات القراء</span>
          </div>
        </div>
      )}
      {message && <div className="admin-message" role="status">{message}</div>}
      <section className="admin-content-studio">
        <header>
          <div><span className="kicker">CONTENT STUDIO</span><h2>إدارة صور الفصول</h2></div>
          <span className="admin-live-badge">قاعدة البيانات والتخزين متصلان</span>
        </header>
        <div className="admin-content-selectors">
          <label>
            الكتاب
            <select value={selectedBookId} onChange={(event) => {
              const nextBook = catalog.find((book) => book.id === event.target.value);
              setSelectedBookId(event.target.value);
              setSelectedChapterId(nextBook?.chapters[0]?.id || "");
            }}>
              {catalog.map((book) => <option key={book.id} value={book.id}>{book.title}</option>)}
            </select>
          </label>
          <label>
            {selectedContentUnitLabel}
            <select value={selectedChapterId} onChange={(event) => setSelectedChapterId(event.target.value)}>
              {(selectedBook?.chapters || []).map((chapter) => (
                <option key={chapter.id} value={chapter.id}>{chapter.position}. {chapter.title} ({chapter.illustrationCount} صورة)</option>
              ))}
            </select>
          </label>
        </div>
        {chapterDetails && (
          <>
            <form className="admin-image-upload" onSubmit={uploadIllustration}>
              <div>
                <h3>إضافة صورة جديدة</h3>
                <p>اختر الصورة ثم حدد هل تظهر في بداية {selectedContentUnitLabel} أو بعد جملة معينة.</p>
              </div>
              <label>ملف الصورة<input name="image" type="file" accept="image/jpeg,image/png,image/webp,image/gif" required /></label>
              <label>وصف بديل<input name="alt" minLength={2} maxLength={180} required placeholder="وصف واضح للصورة" /></label>
              <label>موضع الصورة<select name="afterSentenceId"><option value="">بداية {selectedContentUnitLabel}</option>{chapterDetails.sentences.map((sentence) => <option key={sentence.id} value={sentence.id}>بعد جملة {sentence.position}: {sentence.text.slice(0, 82)}</option>)}</select></label>
              <button className="btn primary" disabled={contentBusy}><ImagePlus size={17} /> {contentBusy ? "جارٍ الحفظ..." : "رفع وإضافة"}</button>
            </form>
            <div className="admin-image-list">
              {chapterDetails.illustrations.map((illustration) => (
                <article key={illustration.id || illustration.src}>
                  <img src={illustration.src} alt={illustration.alt} />
                  {illustration.id ? (
                    <div className="admin-image-controls">
                      <form onSubmit={(event) => editIllustration(event, illustration.id!)}>
                        <label>الوصف<input name="alt" defaultValue={illustration.alt} required /></label>
                        <label>الموضع<select name="afterSentenceId" defaultValue={illustration.afterSentenceId || ""}><option value="">بداية {selectedContentUnitLabel}</option>{chapterDetails.sentences.map((sentence) => <option key={sentence.id} value={sentence.id}>بعد جملة {sentence.position}: {sentence.text.slice(0, 70)}</option>)}</select></label>
                        <button className="btn secondary" disabled={contentBusy}>حفظ الموضع والوصف</button>
                      </form>
                      <form className="admin-replace-image" onSubmit={(event) => replaceIllustration(event, illustration.id!)}>
                        <input name="replacement" type="file" accept="image/jpeg,image/png,image/webp,image/gif" required />
                        <button className="btn secondary" disabled={contentBusy}>استبدال الملف</button>
                      </form>
                      <button
                        type="button"
                        className="admin-danger-button"
                        disabled={contentBusy}
                        onClick={async () => {
                          if (!window.confirm("حذف هذه الصورة من الفصل؟")) return;
                          setContentBusy(true);
                          try {
                            await api(`/admin/chapters/${selectedChapterId}/illustrations/${illustration.id}`, { method: "DELETE" });
                            await Promise.all([reloadChapter(), reloadAudit()]);
                            setMessage("تم حذف الصورة من قاعدة البيانات والموقع");
                          } catch (error) {
                            setMessage((error as Error).message);
                          } finally {
                            setContentBusy(false);
                          }
                        }}
                      ><Trash2 size={15} /> حذف الصورة</button>
                    </div>
                  ) : <p>هذه صورة قديمة غير مُدارة بعد.</p>}
                </article>
              ))}
              {!chapterDetails.illustrations.length && <p className="panel-empty">لا توجد صور في هذا {selectedContentUnitLabel}. تستطيع إضافة أول صورة الآن.</p>}
            </div>
          </>
        )}
      </section>
      <div className="admin-grid">
        <form onSubmit={create} className="admin-form">
          <h2>كتاب جديد</h2>
          <label>
            العنوان
            <input name="title" required />
          </label>
          <label>
            الكاتب
            <input name="author" required />
          </label>
          <label>
            الرابط المختصر
            <input
              name="slug"
              pattern="[a-z0-9-]+"
              required
              placeholder="new-book"
            />
          </label>
          <label>
            النوع
            <input name="genre" required />
          </label>
          <label>
            السعر
            <input name="price" type="number" min="0" required />
          </label>
          <label>
            النبذة
            <textarea name="synopsis" minLength={20} required />
          </label>
          <button className="btn primary">حفظ كمسودة</button>
        </form>
        <div className="users-table">
          <h2>المستخدمون والصلاحيات</h2>
          {users.map((u) => (
            <div key={u.id}>
              {u.avatarUrl ? <img className="mini-avatar" src={u.avatarUrl} alt="" referrerPolicy="no-referrer" /> : <span className="mini-avatar">{u.name[0]}</span>}
              <span>
                <b>{u.name}</b>
                <small>{u.email || (u.oauthProvider === "google" ? "Google" : "حساب مسجل")}</small>
              </span>
              <select
                aria-label={`صلاحية ${u.name}`}
                value={u.role}
                disabled={u.id === user.id}
                onChange={async (event) => {
                  const role = event.target.value as User["role"];
                  try {
                    const result = await api<{ user: User }>(`/admin/users/${u.id}/role`, {
                      method: "PATCH",
                      body: JSON.stringify({ role }),
                    });
                    setUsers((items) => items.map((item) => item.id === u.id ? result.user : item));
                    await reloadAudit();
                    setMessage(`تم تحديث صلاحية ${u.name}`);
                  } catch (error) {
                    setMessage((error as Error).message);
                  }
                }}
              >
                <option value="CUSTOMER">قارئ</option>
                <option value="ADMIN">مدير كامل</option>
              </select>
            </div>
          ))}
        </div>
      </div>
      {selectedBook && (
        <section className="admin-book-editor">
          <header><div><span className="kicker">CATALOG</span><h2>تعديل بيانات الكتاب</h2></div><span>{selectedBook.status === "PUBLISHED" ? "منشور" : "مسودة"}</span></header>
          <form key={selectedBook.id} onSubmit={async (event) => {
            event.preventDefault();
            const fields = new FormData(event.currentTarget);
            try {
              const result = await api<{ book: AdminCatalogBook }>(`/admin/books/${selectedBook.id}`, {
                method: "PATCH",
                body: JSON.stringify({
                  title: String(fields.get("title")),
                  author: String(fields.get("author")),
                  synopsis: String(fields.get("synopsis")),
                  priceMinor: Math.round(Number(fields.get("price")) * 100),
                  status: fields.get("status"),
                }),
              });
              setCatalog((books) => books.map((book) => book.id === selectedBook.id ? { ...book, ...result.book } : book));
              await reloadAudit();
              setMessage("تم حفظ بيانات الكتاب في الموقع وقاعدة البيانات");
            } catch (error) {
              setMessage((error as Error).message);
            }
          }}>
            <label>العنوان<input name="title" defaultValue={selectedBook.title} required /></label>
            <label>الكاتب<input name="author" defaultValue={selectedBook.author} required /></label>
            <label>السعر بالريال<input name="price" type="number" min="0" step="0.01" defaultValue={selectedBook.priceMinor / 100} required /></label>
            <label>الحالة<select name="status" defaultValue={selectedBook.status}><option value="PUBLISHED">منشور</option><option value="DRAFT">مسودة</option></select></label>
            <label className="admin-book-synopsis">النبذة<textarea name="synopsis" minLength={20} defaultValue={selectedBook.synopsis} required /></label>
            <button className="btn primary">حفظ بيانات الكتاب</button>
          </form>
        </section>
      )}
      <section className="admin-reports">
        <header><div><span className="kicker">مراجعة المحتوى</span><h2>بلاغات القراء</h2></div><span>{reports.filter((report) => report.status === "OPEN").length} مفتوح</span></header>
        <div>
          {reports.map((report) => (
            <article key={report.id} className={report.status === "RESOLVED" ? "resolved" : ""}>
              <div><b>{report.bookTitle}</b><small>{report.chapterTitle}</small></div>
              <p>{report.message}</p>
              <small>{report.user?.name || "قارئ"} · {formatDateTime(report.createdAt)}</small>
              <button
                className="btn secondary"
                onClick={async () => {
                  const nextStatus = report.status === "OPEN" ? "RESOLVED" : "OPEN";
                  await api(`/admin/reports/${report.id}`, { method: "PATCH", body: JSON.stringify({ status: nextStatus }) });
                  setReports((items) => items.map((item) => item.id === report.id ? { ...item, status: nextStatus } : item));
                }}
              >
                {report.status === "OPEN" ? "تمت المعالجة" : "إعادة الفتح"}
              </button>
            </article>
          ))}
          {!reports.length && <p className="panel-empty">لا توجد بلاغات حاليًا.</p>}
        </div>
      </section>
      <section className="admin-backups">
        <header>
          <div><span className="kicker">حماية البيانات</span><h2>النسخ الاحتياطية</h2></div>
          <button
            className="btn secondary"
            disabled={backupBusy}
            onClick={async () => {
              setBackupBusy(true);
              try {
                const result = await api<{ backup: any }>("/admin/backups", { method: "POST" });
                setBackups((items) => [result.backup, ...items]);
              } finally {
                setBackupBusy(false);
              }
            }}
          >
            <ShieldCheck size={16} />
            {backupBusy ? "جارٍ الحفظ..." : "إنشاء نسخة الآن"}
          </button>
        </header>
        <div className="backup-list">
          {backups.map((backup) => (
            <article key={backup.id}>
              <span className={`backup-status ${String(backup.status).toLowerCase()}`}>{backup.status}</span>
              <b>{backup.kind}</b>
              <small>{formatDateTime(backup.created_at)}</small>
              <em>{backup.byte_size ? `${Math.max(1, Math.round(backup.byte_size / 1024))} KB` : "—"}</em>
            </article>
          ))}
          {!backups.length && <p className="panel-empty">لا توجد نسخ احتياطية بعد.</p>}
        </div>
      </section>
      <section className="admin-audit-log">
        <header><div><span className="kicker">AUDIT TRAIL</span><h2>سجل التغييرات الفعلي</h2></div><span>{auditLogs.length} عملية</span></header>
        <div>
          {auditLogs.slice(0, 30).map((log) => (
            <article key={log.id}>
              <b>{log.action}</b>
              <span>{log.entity_type || "system"}{log.entity_id ? ` · ${log.entity_id}` : ""}</span>
              <small>{formatDateTime(log.created_at || log.createdAt || new Date().toISOString())}</small>
            </article>
          ))}
          {!auditLogs.length && <p className="panel-empty">سيظهر هنا كل تغيير ينفذه المدير.</p>}
        </div>
      </section>
    </section>
  );
}
function Loading({ dark = false }: { dark?: boolean }) {
  return (
    <div className={`loading ${dark ? "dark" : ""}`}>
      <span></span>
      <p>نفتح الصفحة بهدوء...</p>
    </div>
  );
}
export default App;
