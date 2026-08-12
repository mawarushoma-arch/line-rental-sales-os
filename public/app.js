import {
  applyPropertyDecision,
  clampPercent,
  containsInternalFragment,
  effectiveCandidateStatus,
  isKnownCaseStage,
  moveItem,
  stageAtOrBeyond,
  undoPropertyDecision,
  validateNormalizedModels,
} from "./domain.mjs";
import {
  createApprovedReplyDTO,
  createMockReplyApproval,
  createRentalDataAdapter,
  MockApprovedReplyGateway,
} from "./api-adapter.mjs";

(async () => {
  const accessGate = document.getElementById("access-gate");
  const appShell = document.getElementById("app-shell");
  const appView = document.getElementById("app-view");
  const modalRoot = document.getElementById("modal-root");
  const toastRegion = document.getElementById("toast-region");
  const bottomNav = document.querySelector(".bottom-nav");
  const escapeHTML = (value) =>
    String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");

  /**
   * Access guard runs before any application view or mock business data is rendered.
   * employee: app / pending: employee application / customer: denied.
   */
  function guardAccessBeforeRender() {
    const role = new URLSearchParams(window.location.search).get("role") || "customer";

    if (role === "employee") {
      accessGate.hidden = true;
      appShell.hidden = false;
      return true;
    }

    appShell.hidden = true;
    accessGate.hidden = false;

    if (role === "pending") {
      accessGate.innerHTML = `
        <section class="access-panel" aria-labelledby="access-title">
          <div class="access-brand">
            <span class="brand-mark" aria-hidden="true">R</span>
            <div>
              <p class="brand-name">ROOM PILOT</p>
              <p class="brand-subtitle">LINE賃貸営業OS <span class="mock-badge">モック</span></p>
            </div>
          </div>
          <div class="access-main">
            <div class="access-illustration" aria-hidden="true">⌛</div>
            <p class="access-kicker">EMPLOYEE APPLICATION</p>
            <h1 id="access-title" class="access-title">社員申請を<br />確認中です</h1>
            <p class="access-copy">管理者の承認が完了すると、LINEからそのままROOM PILOTを利用できます。</p>
            <div class="access-info" aria-label="申請状況">
              <div class="access-info-row"><span>申請状況</span><strong>承認待ち</strong></div>
              <div class="access-info-row"><span>申請ID</span><strong>RP-0811-24</strong></div>
              <div class="access-info-row"><span>通常の確認時間</span><strong>1営業日以内</strong></div>
            </div>
            <button class="primary-button wide-button" type="button" data-access-action="reload">状態を再確認</button>
          </div>
          <p class="access-footer">実API・LIFF・ITANDIは未接続のモック画面です</p>
        </section>`;
    } else {
      accessGate.innerHTML = `
        <section class="access-panel" aria-labelledby="access-title">
          <div class="access-brand">
            <span class="brand-mark" aria-hidden="true">R</span>
            <div>
              <p class="brand-name">ROOM PILOT</p>
              <p class="brand-subtitle">LINE賃貸営業OS <span class="mock-badge">モック</span></p>
            </div>
          </div>
          <div class="access-main">
            <div class="access-illustration" aria-hidden="true">×</div>
            <p class="access-kicker">EMPLOYEES ONLY</p>
            <h1 id="access-title" class="access-title">このページには<br />アクセスできません</h1>
            <p class="access-copy">ROOM PILOTは社員専用です。お部屋探しのお客様は、LINEのトーク画面から担当者へご連絡ください。</p>
            <button class="line-button wide-button" type="button" data-access-action="back">LINEに戻る</button>
          </div>
          <p class="access-footer">権限については店舗管理者へお問い合わせください</p>
        </section>`;
    }

    accessGate.addEventListener("click", (event) => {
      const action = event.target.closest("[data-access-action]")?.dataset.accessAction;
      if (action === "reload") window.location.reload();
      if (action === "back") {
        if (window.history.length > 1) window.history.back();
        else window.location.assign("https://line.me/");
      }
    });

    return false;
  }

  if (!guardAccessBeforeRender()) return;

  function setNavigationAvailable(available) {
    bottomNav?.toggleAttribute("inert", !available);
    if (available) bottomNav?.removeAttribute("aria-hidden");
    else bottomNav?.setAttribute("aria-hidden", "true");
  }

  function renderBootstrapSkeleton() {
    setNavigationAvailable(false);
    appShell.classList.add("is-bootstrapping");
    appView.innerHTML = `
      <section class="view bootstrap-view" role="status" aria-live="polite" aria-label="営業データを読み込み中">
        <div class="skeleton-line short"></div>
        <div class="skeleton-line title"></div>
        <div class="skeleton-grid"><div class="skeleton-card"></div><div class="skeleton-card"></div></div>
        <div class="skeleton-line medium"></div>
        <div class="skeleton-panel"></div>
        <p class="sr-only">営業データを読み込んでいます</p>
      </section>`;
  }

  function renderBootstrapError(error) {
    setNavigationAvailable(false);
    appShell.classList.remove("is-bootstrapping");
    appShell.classList.add("has-bootstrap-error");
    const timeout = error?.code === "TIMEOUT";
    appView.innerHTML = `
      <section class="view" aria-labelledby="api-error-title">
        <div class="empty-state api-error-state">
          <div class="empty-state-inner">
            <div class="empty-icon danger" aria-hidden="true">!</div>
            <p class="eyebrow">${timeout ? "TIMEOUT" : "CONNECTION ERROR"}</p>
            <h1 id="api-error-title" class="empty-title">${timeout ? "読み込みに時間がかかっています" : "データを読み込めませんでした"}</h1>
            <p class="empty-copy">${escapeHTML(error?.message || "通信状態を確認して、もう一度お試しください。")}</p>
            <button class="primary-button" type="button" data-bootstrap-action="retry">再試行する</button>
            <p class="small-copy" style="margin-top:12px">入力内容は送信されていません</p>
          </div>
        </div>
      </section>`;
    appView.querySelector("[data-bootstrap-action='retry']")?.addEventListener("click", () => window.location.reload());
  }

  renderBootstrapSkeleton();
  const dataAdapter = createRentalDataAdapter();
  let adapterState;
  try {
    adapterState = await dataAdapter.bootstrap();
  } catch (error) {
    renderBootstrapError(error);
    return;
  }
  appShell.classList.remove("is-bootstrapping");
  setNavigationAvailable(true);

  const APP_VERSION = 2;
  const STORAGE_KEY = `room-pilot:v${APP_VERSION}`;
  const VALID_TABS = ["customers", "properties", "today", "viewings", "cases"];
  const WIDGET_KEYS = ["priority", "recommendation", "deadlines", "timeline"];
  const PROPERTY_FIELD_KEYS = ["listing", "ad", "rent", "address", "layout", "management", "viewing", "moveIn", "initialCost", "note"];
  const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)");
  const MOCK_NOW = Date.parse("2026-08-11T11:20:00+09:00");
  const UNDO_SECONDS = 8;
  // 仕分けの並び替え。営業がその場で切り替える軸だけに絞る。
  const DECK_SORTS = [
    { id: "match", label: "マッチ度順" },
    { id: "rent", label: "家賃が安い順" },
    { id: "ad", label: "AD高い順" },
    { id: "new", label: "新着順" },
  ];
  // マッチした条件は単語のままだと営業が顧客へ言い換える手間が残るので、説明文で持つ。
  const MATCH_REASON_COPY = {
    希望沿線: "希望の沿線・エリアに入っています",
    日当たり: "日当たりの希望を満たしています",
    予算内: "管理費込みで予算の範囲です",
    "駅徒歩10分以内": "駅から徒歩10分以内です",
    間取り: "希望の間取りタイプに合っています",
    入居時期: "希望の入居時期に間に合います",
    在宅スペース: "在宅ワーク用のスペースが取れます",
    築浅: "築年数が希望より新しめです",
    管理費込予算: "管理費を含めても予算内です",
    初期費用: "初期費用が想定の範囲に収まります",
    収納: "収納量の希望を満たしています",
    内見可能日: "内見できる日が顧客の都合と合います",
  };
  const DECK_FILTERS = [
    { id: "hideClosed", label: "募集終了を隠す", copy: "申込あり・募集終了のうち、募集終了だけを外します" },
    { id: "viewableToday", label: "本日内見できる物件だけ", copy: "内見可否が「本日可」のものに絞ります" },
    { id: "hideStale", label: "鮮度が古い物件を隠す", copy: "更新から24時間を超えたものを外します" },
  ];

  const propertySeeds = [
    ["中目黒リバーサイド", "中目黒駅 徒歩6分・1LDK 38.2㎡", 18.2, 1.2, "photo-1522708323590-d24dbb6b0267"],
    ["恵比寿ミモザレジデンス", "恵比寿駅 徒歩8分・1K 28.1㎡", 14.8, 0.8, "photo-1502672260266-1c1ef2d93688"],
    ["代官山コート", "代官山駅 徒歩5分・1DK 31.6㎡", 16.5, 1.0, "photo-1493663284031-b7e3aefcae8e"],
    ["祐天寺テラス", "祐天寺駅 徒歩4分・1LDK 36.5㎡", 17.1, 0.9, "photo-1560448204-e02f11c3d0e2"],
    ["学芸大学ソレイユ", "学芸大学駅 徒歩7分・1DK 30.4㎡", 13.9, 0.7, "photo-1560185008-b033106af5c3"],
    ["三軒茶屋パークサイド", "三軒茶屋駅 徒歩9分・1LDK 40.1㎡", 17.8, 1.1, "photo-1564013799919-ab600027ffc6"],
    ["池尻ブルーム", "池尻大橋駅 徒歩3分・1K 26.8㎡", 13.4, 0.6, "photo-1600566753086-00f18fb6b3ea"],
    ["目黒グリーンヒル", "目黒駅 徒歩10分・1LDK 42.0㎡", 19.2, 1.0, "photo-1600585154340-be6161a56a0c"],
    ["白金台ルーチェ", "白金台駅 徒歩6分・1K 29.7㎡", 15.6, 0.8, "photo-1600566753190-17f0baa2a6c3"],
    ["広尾アーバンネスト", "広尾駅 徒歩8分・1LDK 37.9㎡", 19.8, 1.2, "photo-1600210492486-724fe5c67fb0"],
    ["品川ベイフロント", "品川駅 徒歩12分・1LDK 44.8㎡", 18.6, 1.4, "photo-1545324418-cc1a3fa10c00"],
    ["五反田クレスト", "五反田駅 徒歩5分・1DK 32.3㎡", 14.5, 0.9, "photo-1600607687939-ce8a6c25118c"],
    ["武蔵小山フラット", "武蔵小山駅 徒歩4分・1K 27.5㎡", 12.9, 0.7, "photo-1600607687920-4e2a09cf159d"],
    ["自由が丘ノース", "自由が丘駅 徒歩9分・1LDK 39.4㎡", 17.6, 1.0, "photo-1600566752355-35792bedcfea"],
    ["都立大学ラフィネ", "都立大学駅 徒歩6分・1DK 33.1㎡", 14.2, 0.8, "photo-1600585154526-990dced4db0d"],
    ["大岡山スカイ", "大岡山駅 徒歩5分・1K 25.9㎡", 11.8, 0.6, "photo-1600047509807-ba8f99d2cdde"],
    ["二子玉川リーフ", "二子玉川駅 徒歩8分・1LDK 41.6㎡", 16.9, 1.1, "photo-1618221195710-dd6b41faaea6"],
    ["駒沢オークハウス", "駒沢大学駅 徒歩7分・1DK 34.8㎡", 14.7, 0.8, "photo-1615873968403-89e068629265"],
    ["桜新町アトリエ", "桜新町駅 徒歩4分・1LDK 38.7㎡", 16.2, 0.9, "photo-1600210491892-03d54c0aaf87"],
    ["用賀フォレスト", "用賀駅 徒歩6分・1K 28.6㎡", 12.7, 0.7, "photo-1600607688969-a5bfcd646154"],
  ];

  /** @type {Array<{id:string,name:string,kana:string,assignedTo:string,unassigned:boolean,priority:string,lastContactAt:string,source:string,status:string,stage:string,lineSummary:string,progress:number,searchConditionId:string}>} */
  const Customer = [
    {
      id: "c1",
      name: "藤田 さくら",
      kana: "ふじた さくら",
      assignedTo: "佐藤",
      unassigned: false,
      priority: "urgent",
      lastContactAt: "2026-08-11T11:10:00+09:00",
      source: "LINE広告",
      status: "内見待ち",
      stage: "物件提案",
      lineSummary: "在宅勤務が増えたため、日当たりと仕事スペースを優先。週末の午前中なら内見しやすいとのこと。",
      progress: 42,
      searchConditionId: "sc1",
    },
    {
      id: "c2",
      name: "石井 健太",
      kana: "いしい けんた",
      assignedTo: "",
      unassigned: true,
      priority: "urgent",
      lastContactAt: "2026-08-11T11:16:00+09:00",
      source: "店舗QR",
      status: "新規",
      stage: "初回対応",
      lineSummary: "転勤に伴う住み替え。来月上旬までの入居を希望しているが、勤務先の最寄りは未確認。",
      progress: 12,
      searchConditionId: "sc2",
    },
    {
      id: "c3",
      name: "中村 美咲",
      kana: "なかむら みさき",
      assignedTo: "佐藤",
      unassigned: false,
      priority: "warning",
      lastContactAt: "2026-08-11T10:20:00+09:00",
      source: "SUUMO",
      status: "内見調整中",
      stage: "内見調整",
      lineSummary: "候補2件のうち、駅距離より収納量を重視。8月15日午後の内見を希望。",
      progress: 58,
      searchConditionId: "sc3",
    },
    {
      id: "c4",
      name: "高橋 亮",
      kana: "たかはし りょう",
      assignedTo: "田中",
      unassigned: false,
      priority: "neutral",
      lastContactAt: "2026-08-10T16:00:00+09:00",
      source: "紹介",
      status: "書類待ち",
      stage: "申込準備",
      lineSummary: "内見済み物件で申込を検討中。初期費用の概算を確認してから意思決定予定。",
      progress: 70,
      searchConditionId: "sc4",
    },
    {
      id: "c5",
      name: "森田 結衣",
      kana: "もりた ゆい",
      assignedTo: "",
      unassigned: true,
      priority: "warning",
      lastContactAt: "2026-08-11T10:52:00+09:00",
      source: "Instagram",
      status: "新規",
      stage: "初回対応",
      lineSummary: "ペット可の1LDKを希望。エリアと賃料上限をヒアリングする必要あり。",
      progress: 8,
      searchConditionId: "sc5",
    },
    {
      id: "c6",
      name: "小林 航平",
      kana: "こばやし こうへい",
      assignedTo: "佐藤",
      unassigned: false,
      priority: "neutral",
      lastContactAt: "2026-08-08T11:20:00+09:00",
      source: "HOME'S",
      status: "保留",
      stage: "追客中",
      lineSummary: "更新時期に合わせて情報収集中。急ぎではないが、築浅と角部屋への反応が良い。",
      progress: 31,
      searchConditionId: "sc6",
    },
    {
      id: "c7",
      name: "田辺 直樹",
      kana: "たなべ なおき",
      assignedTo: "佐藤",
      unassigned: false,
      priority: "warning",
      lastContactAt: "2026-08-11T09:20:00+09:00",
      source: "既存顧客",
      status: "契約準備",
      stage: "契約準備",
      lineSummary: "審査承認済み。契約日時と鍵渡し方法の最終確認を進めている。",
      progress: 88,
      searchConditionId: "sc7",
    },
    {
      id: "c8",
      name: "山口 彩",
      kana: "やまぐち あや",
      assignedTo: "佐藤",
      unassigned: false,
      priority: "warning",
      lastContactAt: "2026-08-11T08:40:00+09:00",
      source: "LINE広告",
      status: "審査中",
      stage: "審査中",
      lineSummary: "申込受付済み。保証会社からの追加確認事項に回答し、審査結果を待っている。",
      progress: 79,
      searchConditionId: "sc8",
    },
  ];

  /** @type {Array<{id:string,customerId:string,updatedAt:string,items:Array<{key:string,label:string,value:string,status:'confirmed'|'inferred'|'unknown'}>}>} */
  const SearchCondition = [
    {
      id: "sc1",
      customerId: "c1",
      items: [
        { label: "希望エリア", value: "中目黒・恵比寿・祐天寺", status: "confirmed" },
        { label: "賃料上限", value: "管理費込 20万円", status: "confirmed" },
        { label: "間取り", value: "1LDKが本命", status: "inferred" },
        { label: "入居希望日", value: "まだ確認できていません", status: "unknown" },
      ],
    },
    {
      id: "sc2",
      customerId: "c2",
      items: [
        { label: "入居希望", value: "9月上旬まで", status: "confirmed" },
        { label: "賃料上限", value: "16万円前後", status: "inferred" },
        { label: "勤務先・沿線", value: "まだ確認できていません", status: "unknown" },
      ],
    },
    {
      id: "sc3",
      customerId: "c3",
      items: [
        { label: "希望エリア", value: "三軒茶屋〜学芸大学", status: "confirmed" },
        { label: "収納", value: "WICまたは大型収納", status: "confirmed" },
        { label: "駅距離", value: "徒歩12分まで許容", status: "inferred" },
      ],
    },
    {
      id: "sc4",
      customerId: "c4",
      items: [
        { label: "希望エリア", value: "目黒・五反田", status: "confirmed" },
        { label: "初期費用", value: "60万円以内を希望", status: "confirmed" },
      ],
    },
    {
      id: "sc5",
      customerId: "c5",
      items: [
        { label: "こだわり", value: "ペット相談可", status: "confirmed" },
        { label: "間取り", value: "1LDK", status: "confirmed" },
        { label: "希望エリア", value: "まだ確認できていません", status: "unknown" },
      ],
    },
    {
      id: "sc6",
      customerId: "c6",
      items: [
        { label: "こだわり", value: "築浅・角部屋", status: "inferred" },
        { label: "時期", value: "2か月以内", status: "confirmed" },
      ],
    },
    {
      id: "sc7",
      customerId: "c7",
      items: [
        { label: "契約物件", value: "二子玉川リーフ", status: "confirmed" },
        { label: "鍵渡し", value: "8月20日 午前", status: "confirmed" },
      ],
    },
    {
      id: "sc8",
      customerId: "c8",
      items: [
        { label: "申込物件", value: "五反田クレスト", status: "confirmed" },
        { label: "入居希望", value: "9月1日", status: "confirmed" },
      ],
    },
  ].map((condition) => ({
    ...condition,
    updatedAt: "2026-08-11T11:20:00+09:00",
    items: condition.items.map((item, index) => ({ key: `${condition.id}-item-${index + 1}`, ...item })),
  }));

  const sourceTimes = [
    "2026-08-11T11:08:00+09:00",
    "2026-08-11T10:20:00+09:00",
    "2026-08-11T09:00:00+09:00",
    "2026-08-09T09:00:00+09:00",
  ];

  /** Normalized property facts. Customer-specific matching lives in CandidateProperty. */
  const Property = propertySeeds.map((seed, index) => ({
    id: `p${index + 1}`,
    itandiPropertyId: `mock-itandi-${String(index + 1).padStart(3, "0")}`,
    name: seed[0],
    address: seed[1],
    rentYen: Math.round(seed[2] * 10_000),
    managementFeeYen: Math.round(seed[3] * 10_000),
    imageUrl: `https://images.unsplash.com/${seed[4]}?auto=format&fit=crop&w=900&q=82`,
    // 本番はここへITANDIの物件資料の間取り図を入れる。カードは間取り図を優先し、
    // 無い物件だけ室内写真へ落とす（モックは間取り図を持たないのでnull固定）。
    floorPlanUrl: null,
    listingStatus: index === 13 ? "募集終了" : index % 6 === 0 ? "申込あり" : "募集中",
    listedAt: index % 3 === 0
      ? "2026-08-11T09:00:00+09:00"
      : index % 3 === 1
        ? "2026-08-10T09:00:00+09:00"
        : "2026-08-09T09:00:00+09:00",
    sourceUpdatedAt: sourceTimes[index % sourceTimes.length],
    fetchedAt: "2026-08-11T11:20:00+09:00",
    viewingAvailable: index % 5 === 0 ? "要確認" : index % 4 === 0 ? "8/13〜" : "本日可",
    moveInAt: index % 3 === 0 ? "即入居可" : index % 3 === 1 ? "9月上旬" : "8月下旬",
    initialCostYen: Math.round((seed[2] + seed[3]) * (index % 2 ? 3.4 : 3.8) * 10_000),
    publicNote: index % 3 === 0 ? "短期解約違約金あり。先行申込相談可。" : index % 3 === 1 ? "退去前。写真は同タイプ別部屋です。" : "保証会社利用必須。法人契約相談可。",
    internal: {
      ad: index % 4 === 0 ? "AD 200" : index % 3 === 0 ? "AD 150" : index % 2 === 0 ? "AD 100" : "AD 50",
      // 暗証番号そのものはモックでも持たせない（画面へ出す経路を作らないため）
      keyInfo: index % 3 === 0 ? "社内キーボックス・暗証情報は表示しません" : index % 3 === 1 ? "現地キーボックス・管理会社へ事前連絡" : "管理会社預かり・当日受取",
      managementCompanyNote: index % 5 === 0 ? "元付へ事前確認" : "特記事項なし",
    },
  }));

  const initialLikes = Object.freeze({ c1: ["p18"], c3: ["p5", "p6"] });
  const reasonSets = [
    ["希望沿線", "日当たり", "予算内"],
    ["駅徒歩10分以内", "間取り", "入居時期"],
    ["在宅スペース", "築浅", "管理費込予算"],
    ["初期費用", "収納", "内見可能日"],
  ];

  /** Normalized customer × property relation used by every matching view. */
  const CandidateProperty = Customer.flatMap((customer, customerIndex) =>
    Property.map((property, propertyIndex) => ({
      id: `cp-${customer.id}-${property.id}`,
      customerId: customer.id,
      propertyId: property.id,
      status: initialLikes[customer.id]?.includes(property.id) ? "liked" : "unreviewed",
      matchScore: Math.max(56, 96 - ((propertyIndex * 3 + customerIndex * 7) % 39)),
      matchReasons: reasonSets[(propertyIndex + customerIndex) % reasonSets.length],
      createdAt: "2026-08-11T09:00:00+09:00",
      updatedAt: "2026-08-11T11:20:00+09:00",
    })),
  );

  /** @type {Array<{id:string,customerId:string,propertyId:string,date:string,time:string,range:'today'|'week',meetingPlace:string,vacancyConfirmed:boolean,keyConfirmed:boolean,keyNote:string,routeOrder:number,status:string,impression:string,temperature:string,nextAction:string}>} */
  const Viewing = [
    {
      id: "v1",
      customerId: "c3",
      propertyId: "p6",
      date: "8月11日",
      time: "13:30",
      range: "today",
      meetingPlace: "三軒茶屋駅 南口B",
      vacancyConfirmed: true,
      keyConfirmed: true,
      keyNote: "現地対応・管理会社 30分前連絡",
      routeOrder: 1,
      status: "確定",
      impression: "",
      temperature: "比較検討",
      nextAction: "申込へ進む",
    },
    {
      id: "v2",
      customerId: "c1",
      propertyId: "p1",
      date: "8月11日",
      time: "15:00",
      range: "today",
      meetingPlace: "物件エントランス前",
      vacancyConfirmed: false,
      keyConfirmed: false,
      keyNote: "社内キーボックス B-12 / 暗証情報は表示しません",
      routeOrder: 2,
      status: "確認待ち",
      impression: "",
      temperature: "比較検討",
      nextAction: "申込へ進む",
    },
    {
      id: "v3",
      customerId: "c4",
      propertyId: "p8",
      date: "8月13日",
      time: "11:00",
      range: "week",
      meetingPlace: "目黒駅 正面口",
      vacancyConfirmed: true,
      keyConfirmed: false,
      keyNote: "管理会社へ鍵取り 10:15",
      routeOrder: 1,
      status: "確定",
      impression: "初期費用を確認したい",
      temperature: "前向き",
      nextAction: "申込へ進む",
    },
    {
      id: "v4",
      customerId: "c7",
      propertyId: "p17",
      date: "8月15日",
      time: "14:30",
      range: "week",
      meetingPlace: "二子玉川駅 改札前",
      vacancyConfirmed: false,
      keyConfirmed: false,
      keyNote: "前日までに管理会社へ確認",
      routeOrder: 2,
      status: "仮押さえ",
      impression: "",
      temperature: "比較検討",
      nextAction: "ほかの物件を提案",
    },
  ];

  /** @type {Array<{id:string,customerId:string,propertyId:string,stage:string,nextAction:string,dueAt:string,documentStatus:string,applicationStatus:string,updatedAt:string}>} */
  const Case = [
    { id: "case1", customerId: "c6", propertyId: "p19", stage: "追客中", nextAction: "新着2件をLINEで提案", dueAt: "2026-08-12T10:00:00+09:00", documentStatus: "未着手", applicationStatus: "未申込", updatedAt: "2026-08-11T09:10:00+09:00" },
    { id: "case2", customerId: "c1", propertyId: "p1", stage: "内見調整", nextAction: "空室と鍵を再確認", dueAt: "2026-08-11T12:00:00+09:00", documentStatus: "不要", applicationStatus: "未申込", updatedAt: "2026-08-11T10:55:00+09:00" },
    { id: "case3", customerId: "c3", propertyId: "p6", stage: "内見調整", nextAction: "内見後の感想を記録", dueAt: "2026-08-11T16:30:00+09:00", documentStatus: "不要", applicationStatus: "未申込", updatedAt: "2026-08-11T10:40:00+09:00" },
    { id: "case4", customerId: "c4", propertyId: "p8", stage: "申込準備", nextAction: "初期費用明細を共有", dueAt: "2026-08-13T17:00:00+09:00", documentStatus: "本人確認書類 待ち", applicationStatus: "入力 60%", updatedAt: "2026-08-11T08:50:00+09:00" },
    { id: "case5", customerId: "c8", propertyId: "p12", stage: "審査中", nextAction: "保証会社の追加質問へ回答", dueAt: "2026-08-14T12:00:00+09:00", documentStatus: "追加書類 1点", applicationStatus: "審査受付済み", updatedAt: "2026-08-11T11:05:00+09:00" },
    { id: "case6", customerId: "c7", propertyId: "p17", stage: "契約準備", nextAction: "契約日時を最終確認", dueAt: "2026-08-16T18:00:00+09:00", documentStatus: "契約書作成中", applicationStatus: "承認済み", updatedAt: "2026-08-11T10:15:00+09:00" },
  ];

  /** @type {Array<{id:string,kind:'priority'|'deadline',title:string,customerId:string,dueAt:string,urgency:string,action:string,status:'todo'|'done'}>} */
  const TodayAction = [
    { id: "ta1", kind: "priority", title: "空室と鍵を再確認", customerId: "c1", dueAt: "2026-08-11T12:00:00+09:00", urgency: "urgent", action: "内見準備", status: "todo" },
    { id: "ta2", kind: "priority", title: "初回LINEへ返信", customerId: "c2", dueAt: "2026-08-11T11:35:00+09:00", urgency: "urgent", action: "返信", status: "todo" },
    { id: "ta3", kind: "priority", title: "初期費用明細を共有", customerId: "c4", dueAt: "2026-08-11T18:00:00+09:00", urgency: "warning", action: "書類", status: "todo" },
    { id: "ta6", kind: "priority", title: "新規反響の担当になる", customerId: "c5", dueAt: "2026-08-11T11:50:00+09:00", urgency: "warning", action: "未割当", status: "todo" },
    { id: "ta7", kind: "priority", title: "本日の内見ルートを確認", customerId: "c3", dueAt: "2026-08-11T13:00:00+09:00", urgency: "neutral", action: "内見", status: "todo" },
    { id: "ta8", kind: "priority", title: "契約・鍵渡し日時を確認", customerId: "c7", dueAt: "2026-08-11T18:00:00+09:00", urgency: "warning", action: "契約", status: "todo" },
    { id: "ta4", kind: "deadline", title: "申込情報の不足項目を確認", customerId: "c4", dueAt: "2026-08-11T17:00:00+09:00", urgency: "urgent", action: "申込", status: "todo" },
    { id: "ta5", kind: "deadline", title: "新着物件を2件提案", customerId: "c6", dueAt: "2026-08-12T10:00:00+09:00", urgency: "warning", action: "追客", status: "todo" },
  ];

  /** Device-local mock preference. Production ownership comes from the authenticated sales user. */
  const DisplayPreference = {
    salesUserId: "employee:sato",
    updatedAt: "2026-08-11T11:20:00+09:00",
    widgets: [...WIDGET_KEYS],
    propertyFields: [...PROPERTY_FIELD_KEYS],
    availableWidgets: [
      { id: "priority", label: "優先アクション", description: "今すぐ動く3件を表示" },
      { id: "deadlines", label: "期限", description: "今日・明日の締切を表示" },
      { id: "recommendation", label: "推奨する1操作", description: "迷わないための主行動を表示" },
      { id: "timeline", label: "今日のタイムライン", description: "予定と連絡を時系列で表示" },
    ],
    availablePropertyFields: [
      { id: "listing", label: "募集状況", description: "募集・申込・終了を表示" },
      { id: "ad", label: "AD", description: "社内限定の広告料情報" },
      { id: "rent", label: "賃料", description: "月額賃料" },
      { id: "management", label: "管理費", description: "共益費を含む月額" },
      { id: "address", label: "場所", description: "最寄駅と徒歩分数" },
      { id: "layout", label: "間取り", description: "間取りタイプと専有面積" },
      { id: "viewing", label: "内見可否", description: "最新確認状態" },
      { id: "moveIn", label: "入居可能日", description: "入居開始の目安" },
      { id: "initialCost", label: "初期費用概算", description: "円単位モデルから表示" },
      { id: "note", label: "備考", description: "顧客へ説明できる公開備考" },
    ],
  };

  /** Common mock domain model. Real APIs / LIFF / ITANDI are intentionally not connected. */
  const MockModel = Object.freeze({
    Customer,
    Property,
    SearchCondition,
    CandidateProperty,
    Viewing,
    Case,
    TodayAction,
    DisplayPreference,
  });
  const modelErrors = validateNormalizedModels(MockModel);
  if (modelErrors.length) throw new Error(`Mock model contract violation: ${modelErrors.join("; ")}`);
  const INTERNAL_REPLY_FRAGMENTS = [
    ...Property.flatMap((property) => Object.values(property.internal || {})),
    ...Viewing.map((viewing) => viewing.keyNote),
  ];

  /**
   * 公式LINEのトーク。direction は in=顧客から / out=営業から。
   * 本番はWebhookで受けた本文をサーバーへ保存し、この形へ正規化して配る。
   * 送信も同じくサーバー経由で、営業の承認記録が揃ったときだけMessaging APIを呼ぶ。
   */
  const talkSeeds = {
    c1: [
      ["in", "09:42", "ありがとうございます。日当たりも重視したいです。"],
      ["out", "09:48", "承知しました。仕事スペースも含めて候補を整理します。"],
      ["in", "10:05", "週末の午前なら内見できます。"],
    ],
    c2: [["in", "11:16", "はじめまして。9月上旬までに引っ越したいのですが、相談できますか？"]],
    c3: [
      ["in", "10:02", "三軒茶屋あたりで探しています。収納が多い部屋が希望です。"],
      ["out", "10:14", "承知しました。本日13:30の内見枠を確保しています。"],
    ],
    c4: [
      ["out", "昨日 18:20", "初期費用の明細をお送りします。ご確認ください。"],
      ["in", "昨日 21:05", "ありがとうございます。明日確認します。"],
    ],
  };
  const INCOMING_SAMPLES = [
    "先ほどの物件、駅からの道は明るいですか？",
    "内見は土曜の午前でも大丈夫でしょうか。",
    "初期費用はもう少し抑えられますか？",
    "ペット可の物件も見てみたいです。",
  ];

  function createDefaultState() {
    return {
      version: APP_VERSION,
      activeTab: "today",
      selectedCustomerId: null,
      decisions: {},
      displayPreference: {
        widgets: [...DisplayPreference.widgets],
        propertyFields: [...DisplayPreference.propertyFields],
      },
    };
  }

  function sanitizeDecisions(value) {
    const output = {};
    if (!value || typeof value !== "object") return output;
    for (const customer of Customer) {
      const record = value[customer.id];
      if (!record || typeof record !== "object") continue;
      const validIds = new Set(Property.map((property) => property.id));
      const liked = Array.isArray(record.liked) ? record.liked.filter((id) => validIds.has(id)) : [];
      const skipped = Array.isArray(record.skipped) ? record.skipped.filter((id) => validIds.has(id) && !liked.includes(id)) : [];
      output[customer.id] = { liked: [...new Set(liked)], skipped: [...new Set(skipped)] };
    }
    return output;
  }

  function loadState() {
    const fallback = createDefaultState();
    try {
      const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "null");
      if (!stored || stored.version !== APP_VERSION) return fallback;
      const selectedCustomerId = Customer.some((customer) => customer.id === stored.selectedCustomerId)
        ? stored.selectedCustomerId
        : null;
      const widgets = Array.isArray(stored.displayPreference?.widgets)
        ? stored.displayPreference.widgets.filter((widget) => WIDGET_KEYS.includes(widget))
        : fallback.displayPreference.widgets;
      const propertyFields = Array.isArray(stored.displayPreference?.propertyFields)
        ? stored.displayPreference.propertyFields.filter((field) => PROPERTY_FIELD_KEYS.includes(field))
        : fallback.displayPreference.propertyFields;
      return {
        version: APP_VERSION,
        activeTab: VALID_TABS.includes(stored.activeTab) ? stored.activeTab : fallback.activeTab,
        selectedCustomerId,
        decisions: sanitizeDecisions(stored.decisions),
        displayPreference: {
          widgets: widgets.length ? [...new Set(widgets)] : fallback.displayPreference.widgets,
          propertyFields: propertyFields.length ? [...new Set(propertyFields)] : fallback.displayPreference.propertyFields,
        },
      };
    } catch {
      return fallback;
    }
  }

  let state = loadState();
  const runtime = {
    customerFilter: "all",
    customerSearch: "",
    viewingRange: "today",
    completedTodayActions: new Set(),
    previousFocus: null,
    undo: null,
    decisionPending: false,
    preferenceDraft: null,
    sentReplies: new Map(),
    replyPending: false,
    deckCursor: 0,
    deckSlide: null,
    suppressCardClick: false,
    deckSort: "match",
    deckFilters: { hideClosed: false, viewableToday: false, hideStale: false },
    deckMenuOpen: false,
    talks: new Map(
      Object.entries(talkSeeds).map(([customerId, rows]) => [
        customerId,
        rows.map(([direction, at, body], index) => ({
          id: `${customerId}-m${index + 1}`,
          customerId,
          direction,
          at,
          body,
          status: direction === "in" ? "received" : "sent",
        })),
      ]),
    ),
    talkDraft: "",
    talkCustomerId: null,
    incomingCount: 0,
  };
  const replyGateway = new MockApprovedReplyGateway();
  let undoTimer = 0;
  let undoInterval = 0;
  let toastTimer = 0;

  function persistState() {
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          version: APP_VERSION,
          activeTab: state.activeTab,
          selectedCustomerId: state.selectedCustomerId,
          decisions: state.decisions,
          displayPreference: state.displayPreference,
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  function customerById(id) {
    return MockModel.Customer.find((customer) => customer.id === id);
  }

  function propertyById(id) {
    return MockModel.Property.find((property) => property.id === id);
  }

  function candidateByIds(customerId, propertyId) {
    return MockModel.CandidateProperty.find(
      (candidate) => candidate.customerId === customerId && candidate.propertyId === propertyId,
    );
  }

  function decisionRecord(customerId) {
    if (!state.decisions[customerId]) state.decisions[customerId] = { liked: [], skipped: [] };
    return state.decisions[customerId];
  }

  function candidateIdsForCustomer(customerId) {
    return Property.filter(
      (property) => effectiveStatusForProperty(customerId, property.id) === "liked",
    ).map((property) => property.id);
  }

  function effectiveStatusForProperty(customerId, propertyId) {
    const relation = candidateByIds(customerId, propertyId);
    return effectiveCandidateStatus(relation?.status, state.decisions[customerId], propertyId);
  }

  /** 保存＝しおりを挟む操作なので、好意を表すハートではなくブックマークで示す。 */
  const SAVE_ICON =
    '<svg class="icon-glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 3.5h10a1.5 1.5 0 0 1 1.5 1.5v15.1a.9.9 0 0 1-1.38.76L12 17.4l-5.12 3.46A.9.9 0 0 1 5.5 20.1V5A1.5 1.5 0 0 1 7 3.5Z" fill="currentColor"/></svg>';

  /** 本番は物件資料の間取り図を出す。無い物件だけ室内写真へ落とす。 */
  function propertyVisual(property) {
    if (property.floorPlanUrl) return { url: property.floorPlanUrl, kind: "is-floorplan", label: "間取り図" };
    return { url: property.imageUrl, kind: "is-photo", label: "室内写真（間取り図は未提供）" };
  }

  /** 住所文字列は「駅徒歩・間取り」で持っているので、表示側で2項目へ割る。 */
  function propertyPlaceParts(property) {
    const [walk, layout] = String(property.address).split("・");
    return [walk?.trim() || "所在 未確認", layout?.trim() || "間取り 未確認"];
  }

  function listingTone(listingStatus) {
    if (listingStatus === "募集終了") return "urgent";
    if (listingStatus === "申込あり") return "warning";
    return "success";
  }

  /** ADは率だけだと手取りが見えないので、賃料から換算した金額と併記する。 */
  function adBreakdown(property) {
    const percent = adValue(property);
    if (!percent) return { percent: 0, amount: 0, label: "AD 未確認" };
    const amount = Math.round((property.rentYen * percent) / 100);
    return { percent, amount, label: `${amount.toLocaleString("ja-JP")}円 / ${percent}%` };
  }

  function adValue(property) {
    const parsed = Number.parseInt(String(property.internal?.ad || "").replace(/[^0-9]/g, ""), 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function matchingPropertiesForCustomer(customerId) {
    const score = (property) => candidateByIds(customerId, property.id)?.matchScore ?? 0;
    // 同点は必ずマッチ度で決着させ、並び替えを切り替えても順序がぶれないようにする。
    const comparators = {
      match: (left, right) => score(right) - score(left),
      rent: (left, right) =>
        left.rentYen + left.managementFeeYen - (right.rentYen + right.managementFeeYen) || score(right) - score(left),
      ad: (left, right) => adValue(right) - adValue(left) || score(right) - score(left),
      new: (left, right) => Date.parse(right.listedAt) - Date.parse(left.listedAt) || score(right) - score(left),
    };
    return [...Property].sort(comparators[runtime.deckSort] || comparators.match);
  }

  function passesDeckFilters(property) {
    const filters = runtime.deckFilters;
    if (filters.hideClosed && property.listingStatus === "募集終了") return false;
    if (filters.viewableToday && property.viewingAvailable !== "本日可") return false;
    if (filters.hideStale && propertyIsStale(property)) return false;
    return true;
  }

  function activeDeckFilterCount() {
    return Object.values(runtime.deckFilters).filter(Boolean).length;
  }

  function isTodayActionDone(item) {
    if (item.status === "done") return true;
    if (item.id === "ta2") return runtime.sentReplies.has(item.customerId);
    if (item.id === "ta6") return !customerById(item.customerId)?.unassigned;
    return runtime.completedTodayActions.has(item.id);
  }

  function yen(value) {
    return `${Math.round(Number(value) || 0).toLocaleString("ja-JP")}円`;
  }

  // カード表面は桁を読ませず一目で比べたいので万円表記にする。詳細シートは円表記のまま。
  function manYen(value) {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return "賃料 未確認";
    const man = amount / 10_000;
    return `${Number.isInteger(man) ? man : man.toFixed(1)}万円`;
  }

  function dateParts(iso) {
    const date = new Date(iso);
    if (!Number.isFinite(date.getTime())) return null;
    return {
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: String(date.getHours()).padStart(2, "0"),
      minute: String(date.getMinutes()).padStart(2, "0"),
    };
  }

  function relativeCustomerTime(iso) {
    const timestamp = Date.parse(iso);
    if (!Number.isFinite(timestamp)) return "連絡日時 未確認";
    const minutes = Math.max(0, Math.round((MOCK_NOW - timestamp) / 60_000));
    const parts = dateParts(iso);
    if (minutes < 60) return `${minutes}分前`;
    if (parts?.day === 11) return `${Math.floor(minutes / 60)}時間前`;
    if (parts?.day === 10) return "昨日";
    return `${Math.max(2, Math.floor(minutes / 1_440))}日前`;
  }

  function listedDate(iso) {
    const parts = dateParts(iso);
    return parts ? `${parts.month}/${parts.day}` : "掲載日 未確認";
  }

  function dueCalendarLabel(iso) {
    const parts = dateParts(iso);
    if (!parts) return "期限 未確認";
    const dayLabel = parts.day === 11 ? "今日" : parts.day === 12 ? "明日" : `${parts.month}/${parts.day}`;
    return `${dayLabel} ${parts.hour}:${parts.minute}`;
  }

  function priorityDueLabel(item) {
    const timestamp = Date.parse(item.dueAt);
    if (!Number.isFinite(timestamp)) return "期限 未確認";
    const minutes = Math.round((timestamp - MOCK_NOW) / 60_000);
    if (minutes > 0 && minutes <= 30) return `${minutes}分以内`;
    const parts = dateParts(item.dueAt);
    if (parts?.day === 11 && parts.hour === "18" && parts.minute === "00") return "今日中";
    if (parts?.day === 11) return `${parts.hour}:${parts.minute}まで`;
    return dueCalendarLabel(item.dueAt);
  }

  function relativeSourceTime(iso) {
    const timestamp = Date.parse(iso);
    if (!Number.isFinite(timestamp)) return "日時不明";
    const minutes = Math.max(0, Math.round((MOCK_NOW - timestamp) / 60_000));
    if (minutes < 60) return `${minutes}分前`;
    if (minutes < 24 * 60) return minutes < 120 ? "1時間前" : `${Math.floor(minutes / 60)}時間前`;
    return `${Math.floor(minutes / 1_440)}日前`;
  }

  function propertyIsStale(property) {
    const sourceUpdatedAt = Date.parse(property.sourceUpdatedAt);
    const fetchedAt = Date.parse(property.fetchedAt);
    return (
      adapterState.stale ||
      !Number.isFinite(sourceUpdatedAt) ||
      !Number.isFinite(fetchedAt) ||
      sourceUpdatedAt > fetchedAt ||
      fetchedAt - sourceUpdatedAt > 24 * 60 * 60 * 1_000
    );
  }

  /**
   * 鮮度警告は物件画面だけでなく、空室・鍵を実際に扱う今日／内見でも同じ文言で出す。
   * 重要操作の直前に警告する方針（docs/architecture.md 6章）に合わせるため。
   */
  function renderFreshnessWarning(copy) {
    if (!adapterState.stale) return "";
    return `<div class="freshness-warning" role="status"><strong>情報が古い可能性があります</strong><span>${escapeHTML(copy)}</span></div>`;
  }

  function showToast(message, duration = 2300) {
    if (runtime.undo) clearUndoToast();
    window.clearTimeout(toastTimer);
    toastRegion.innerHTML = `<div class="toast"><span>${escapeHTML(message)}</span></div>`;
    toastTimer = window.setTimeout(() => {
      toastRegion.innerHTML = "";
    }, duration);
  }

  function clearUndoToast() {
    window.clearTimeout(undoTimer);
    window.clearInterval(undoInterval);
    undoTimer = 0;
    undoInterval = 0;
    runtime.undo = null;
    toastRegion.innerHTML = "";
  }

  function showUndoToast(property, action, { storageFailed = false } = {}) {
    window.clearTimeout(toastTimer);
    window.clearTimeout(undoTimer);
    window.clearInterval(undoInterval);
    const verb = action === "liked" ? "候補に保存しました" : "スキップしました";
    // 連続で仕分けている最中でも押し切れるよう、猶予は8秒とる。
    let remaining = UNDO_SECONDS;
    const draw = () => {
      toastRegion.innerHTML = `
        <div class="toast">
          <span>「${escapeHTML(property.name)}」を${verb}${storageFailed ? " · 端末保存なし" : ""}</span>
          <button class="toast-button" type="button" data-action="undo-decision" aria-label="${UNDO_SECONDS}秒以内に直前の判断を元に戻す">元に戻す <span data-undo-countdown aria-hidden="true">（${remaining}秒）</span></button>
        </div>`;
    };
    draw();
    undoInterval = window.setInterval(() => {
      remaining -= 1;
      const countdown = toastRegion.querySelector("[data-undo-countdown]");
      if (remaining > 0 && runtime.undo && countdown) countdown.textContent = `（${remaining}秒）`;
    }, 1000);
    undoTimer = window.setTimeout(clearUndoToast, UNDO_SECONDS * 1000);
  }

  function renderApp({ focusMain = false, focusSelector = null } = {}) {
    const renderers = {
      customers: renderCustomers,
      properties: renderProperties,
      today: renderToday,
      viewings: renderViewings,
      cases: renderCases,
    };
    appView.innerHTML = renderers[state.activeTab]();
    document.body.classList.toggle("deck-mode", state.activeTab === "properties");
    document.querySelectorAll("[data-tab]").forEach((button) => {
      if (button.dataset.tab === state.activeTab) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    if (state.activeTab === "properties") attachSwipeInteractions();
    if (focusMain) appView.focus({ preventScroll: true });
    else if (focusSelector) window.requestAnimationFrame(() => appView.querySelector(focusSelector)?.focus({ preventScroll: true }));
  }

  function setActiveTab(tab) {
    if (!VALID_TABS.includes(tab) || tab === state.activeTab) return;
    if (runtime.undo) clearUndoToast();
    runtime.deckMenuOpen = false;
    closeModal();
    state.activeTab = tab;
    const saved = persistState();
    renderApp({ focusMain: true });
    // 先に描画してから先頭へ戻す。smoothだと入れ替え中に中断され、前の画面のスクロール量が残る。
    scrollViewToTop();
    if (!saved) showToast("この端末では現在地を保存できませんでした");
  }

  function scrollViewToTop() {
    window.scrollTo({ top: 0, behavior: "auto" });
    window.requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "auto" }));
  }

  function renderToday() {
    const priorities = TodayAction.filter((item) => item.kind === "priority");
    const deadlines = TodayAction.filter((item) => item.kind === "deadline");
    const replySent = runtime.sentReplies.has("c2");
    const widgets = {
      priority: `
        <section class="section" aria-labelledby="priority-heading">
          <div class="section-heading">
            <h2 id="priority-heading" class="section-title">優先アクション</h2>
            <span class="section-note">上から順に進める</span>
          </div>
          ${priorities.slice(0, 3).map((item, index) => renderPriorityAction(item, index)).join("")}
        </section>`,
      recommendation: `
        <section class="section" aria-labelledby="recommend-heading">
          <div class="section-heading">
            <h2 id="recommend-heading" class="section-title">推奨する1操作</h2>
            <span class="mini-badge">AI補助</span>
          </div>
          <div class="card recommend-card">
            <div class="row" style="gap: 13px; align-items: flex-start;">
              <span class="recommend-mark" aria-hidden="true">${replySent ? "✓" : "↗"}</span>
              <div>
                <h3 class="card-title">${replySent ? "石井さんへ返信済み" : "石井さんへの返信案を確認"}</h3>
                <p class="card-copy">${replySent ? "営業確認後の本文をモック送信記録へ保存しました。" : "初回返信を先に終えると、希望条件の回収と候補提案が今日中につながります。"}</p>
              </div>
            </div>
            ${replySent ? '<button class="ghost-button wide-button" type="button" data-action="open-reply">送信記録を確認</button>' : '<button class="primary-button wide-button" type="button" data-action="open-reply">返信案を確認する</button>'}
          </div>
        </section>`,
      deadlines: `
        <section class="section" aria-labelledby="deadline-heading">
          <div class="section-heading">
            <h2 id="deadline-heading" class="section-title">期限</h2>
            <span class="section-note">2件</span>
          </div>
          <ul class="deadline-list">
            ${deadlines.map((item) => {
              const customer = customerById(item.customerId);
              const [day, time] = dueCalendarLabel(item.dueAt).split(" ");
              return `<li><button class="deadline-row" type="button" data-action="open-customer" data-id="${customer.id}">
                <span class="deadline-date">${escapeHTML(day)}<br />${escapeHTML(time || "")}</span>
                <div class="deadline-main"><p class="deadline-title">${escapeHTML(item.title)}</p><p class="person-meta">${escapeHTML(customer.name)} · ${escapeHTML(item.action)}</p></div>
                <span class="chevron" aria-hidden="true">›</span>
              </button></li>`;
            }).join("")}
          </ul>
        </section>`,
      timeline: `
        <section class="section" aria-labelledby="timeline-heading">
          <div class="section-heading"><h2 id="timeline-heading" class="section-title">今日のタイムライン</h2><span class="section-note">現在 11:20</span></div>
          <ol class="timeline">
            ${[
              ["10:30", "管理会社へ空室確認", "中目黒リバーサイド", "past"],
              ["11:20", "現在", "次は内見準備", "now"],
              ["13:30", "内見 · 中村 美咲さん", "三軒茶屋駅 南口B集合", "future"],
              ["15:00", "内見 · 藤田 さくらさん", "物件エントランス前集合", "future"],
              ["17:00", "申込情報の確認期限", "高橋 亮さん", "future"],
            ].map(([time, title, copy, timing]) => `<li class="timeline-item ${timing}"><time class="timeline-time">${time}</time><span class="timeline-dot" aria-hidden="true"></span><div><p class="timeline-title">${title}</p><p class="timeline-copy">${copy}</p></div></li>`).join("")}
          </ol>
        </section>`,
    };
    return `
      <section class="view" aria-labelledby="today-title">
        <header class="view-header">
          <div>
            <p class="eyebrow">GOOD MORNING, 佐藤さん</p>
            <h1 id="today-title" class="page-title">今日の操縦席</h1>
          </div>
          <p class="date-chip">8月11日 火</p>
        </header>
        ${renderFreshnessWarning("空室・鍵・金額は、提案と内見の前に再確認してください")}

        <div class="summary-grid" aria-label="本日の概要">
          <div class="metric-card"><span class="metric-label">優先アクション</span><strong class="metric-value">${priorities.length}<span class="metric-unit">件</span></strong></div>
          <div class="metric-card"><span class="metric-label">本日の内見</span><strong class="metric-value">2<span class="metric-unit">組</span></strong></div>
        </div>
        ${state.displayPreference.widgets.map((key) => widgets[key] || "").join("")}

        <section class="section">
          <button class="ghost-button wide-button" type="button" data-action="edit-preference" data-preference="widgets">表示ウィジェットを編集</button>
        </section>
      </section>`;
  }

  function renderPriorityAction(item, index) {
    const customer = customerById(item.customerId);
    const done = isTodayActionDone(item);
    const lockedDone = done && (item.id === "ta2" || item.id === "ta6");
    const processAction = item.id === "ta2" ? "open-reply" : item.id === "ta6" ? "open-customer" : "complete-today-action";
    const processId = item.id === "ta6" ? customer.id : item.id;
    const controlLabel = lockedDone
      ? `${item.title}は完了済み`
      : item.id === "ta2"
        ? "返信案を確認する"
        : item.id === "ta6"
          ? "担当取得へ進む"
          : `${item.title}を${done ? "未完了に戻す" : "完了にする"}`;
    return `
      <article class="card priority-card${done ? " is-done" : ""}">
        <div class="card-body">
          <div class="priority-top">
            <span class="priority-index" aria-hidden="true">0${index + 1}</span>
            <div class="priority-main">
              <h3 class="card-title">${done ? "完了 · " : ""}${escapeHTML(item.title)}</h3>
              <p class="card-copy">${escapeHTML(customer.name)} · ${escapeHTML(customer.status)}</p>
              <div class="priority-meta"><span class="status-pill ${item.urgency}">${escapeHTML(priorityDueLabel(item))}</span><span class="status-pill neutral">${escapeHTML(item.action)}</span></div>
            </div>
            <button class="icon-button" type="button" data-action="${processAction}" data-id="${processId}" ${lockedDone ? "disabled" : ""} aria-label="${escapeHTML(controlLabel)}">${lockedDone ? "✓" : item.id === "ta2" || item.id === "ta6" ? "→" : done ? "↶" : "✓"}</button>
          </div>
        </div>
      </article>`;
  }

  function renderCustomers() {
    const unassigned = Customer.filter((customer) => customer.unassigned);
    return `
      <section class="view" aria-labelledby="customers-title">
        <header class="view-header">
          <div><p class="eyebrow">CUSTOMERS</p><h1 id="customers-title" class="page-title">顧客</h1></div>
          <span class="date-chip">全 ${Customer.length}名</span>
        </header>

        <section class="card inbox-card" aria-labelledby="inbox-title">
          <div class="inbox-head">
            <div><h2 id="inbox-title" class="card-title">未割当箱</h2><p class="card-copy">新着を取りこぼさない</p></div>
            <span class="count-badge">${unassigned.length}</span>
          </div>
          ${unassigned.slice(0, 1).map((customer) => `<div class="inbox-person">
            <span class="person-avatar accent" aria-hidden="true">${escapeHTML(customer.name.slice(0, 1))}</span>
            <div class="person-main"><p class="person-name">${escapeHTML(customer.name)}</p><p class="person-meta">${escapeHTML(customer.source)} · ${escapeHTML(relativeCustomerTime(customer.lastContactAt))}</p></div>
            <button class="primary-button compact-button" type="button" data-action="open-customer" data-id="${customer.id}">確認</button>
          </div>`).join("")}
        </section>

        <div class="search-wrap">
          <span class="search-icon" aria-hidden="true">⌕</span>
          <label class="sr-only" for="customer-search">顧客を検索</label>
          <input id="customer-search" class="search-input" type="search" placeholder="名前・条件・流入元で検索" autocomplete="off" value="${escapeHTML(runtime.customerSearch)}" />
        </div>
        <div class="filter-row" aria-label="顧客フィルター">
          ${[
            ["all", "すべて"],
            ["urgent", "要対応"],
            ["unassigned", "未割当"],
            ["followup", "追客中"],
          ].map(([id, label]) => `<button class="filter-chip" type="button" data-action="customer-filter" data-filter="${id}" aria-pressed="${runtime.customerFilter === id}">${label}</button>`).join("")}
        </div>

        <section class="section" aria-labelledby="customer-list-heading">
          <div class="section-heading"><h2 id="customer-list-heading" class="section-title">顧客一覧</h2><span id="customer-result-count" class="section-note"></span></div>
          <div id="customer-results">${renderCustomerResults()}</div>
        </section>
      </section>`;
  }

  function getFilteredCustomers() {
    const query = runtime.customerSearch.trim().toLocaleLowerCase("ja");
    return Customer.filter((customer) => {
      const matchesSearch = !query || [customer.name, customer.kana, customer.source, customer.status, customer.stage, customer.lineSummary]
        .some((value) => value.toLocaleLowerCase("ja").includes(query));
      const matchesFilter =
        runtime.customerFilter === "all" ||
        (runtime.customerFilter === "urgent" && customer.priority === "urgent") ||
        (runtime.customerFilter === "unassigned" && customer.unassigned) ||
        (runtime.customerFilter === "followup" && customer.stage === "追客中");
      return matchesSearch && matchesFilter;
    });
  }

  function renderCustomerResults() {
    const filtered = getFilteredCustomers();
    window.requestAnimationFrame(() => {
      const count = document.getElementById("customer-result-count");
      if (count) count.textContent = `${filtered.length}名`;
    });
    if (!filtered.length) {
      return `<div class="empty-state" style="min-height:220px"><div class="empty-state-inner"><div class="empty-icon" aria-hidden="true">⌕</div><h3 class="empty-title">該当する顧客はいません</h3><p class="empty-copy">検索語やフィルターを変えてください。</p></div></div>`;
    }
    return `<ul class="customer-list">${filtered.map((customer) => {
      const condition = SearchCondition.find((item) => item.id === customer.searchConditionId);
      const summary = condition?.items.slice(0, 3).map((item) => item.value).join(" · ") || "条件確認中";
      const action = TodayAction.find((item) => item.customerId === customer.id);
      return `<li>
        <button class="customer-item ${state.selectedCustomerId === customer.id ? "selected" : ""}" type="button" data-action="open-customer" data-id="${customer.id}">
          <span class="person-avatar" aria-hidden="true">${escapeHTML(customer.name.slice(0, 1))}</span>
          <span class="person-main"><span class="person-name">${escapeHTML(customer.name)}${customer.unassigned ? '<span class="unread-dot" aria-label="未読あり"></span>' : ""}</span><span class="person-meta">${escapeHTML(customer.status)} · ${escapeHTML(relativeCustomerTime(customer.lastContactAt))}</span><span class="customer-condition">${escapeHTML(summary)}</span>${action ? `<span class="customer-next">次：${escapeHTML(action.title)} · ${escapeHTML(priorityDueLabel(action))}</span>` : ""}</span>
          <span class="customer-trailing"><span class="status-pill ${customer.priority}">${customer.unassigned ? "未割当" : escapeHTML(customer.assignedTo)}</span><span class="chevron" aria-hidden="true">›</span></span>
        </button>
      </li>`;
    }).join("")}</ul>`;
  }

  function refreshCustomerResults() {
    const results = document.getElementById("customer-results");
    if (results) results.innerHTML = renderCustomerResults();
  }

  function renderProperties() {
    const selected = customerById(state.selectedCustomerId);
    if (!selected) {
      return `
        <section class="view" aria-labelledby="properties-title">
          <header class="view-header"><div><p class="eyebrow">MATCHING</p><h1 id="properties-title" class="page-title">物件</h1></div></header>
          <div class="empty-state"><div class="empty-state-inner"><div class="empty-icon" aria-hidden="true">♙</div><h2 class="empty-title">先に顧客を選んでください</h2><p class="empty-copy">希望条件と照合して、一人ひとりに合う物件だけを表示します。</p><button class="secondary-button" type="button" data-action="go-customers">顧客を選ぶ</button></div></div>
        </section>`;
    }

    const orderedProperties = matchingPropertiesForCustomer(selected.id);
    const statuses = new Map(
      orderedProperties.map((property) => [property.id, effectiveStatusForProperty(selected.id, property.id)]),
    );
    const unreviewed = adapterState.empty
      ? []
      : orderedProperties.filter((property) => statuses.get(property.id) === "unreviewed");
    const remaining = unreviewed.filter(passesDeckFilters);
    const hiddenByFilter = unreviewed.length - remaining.length;
    const likedProperties = orderedProperties.filter((property) => statuses.get(property.id) === "liked");
    const likedCount = likedProperties.length;
    const skippedCount = [...statuses.values()].filter((status) => status === "skipped").length;
    // 横スワイプは判断せず前後へ送るだけなので、いま見ている位置を保持する。
    const cursor = clampDeckCursor(remaining.length);
    const current = remaining[cursor];
    const previous = remaining[cursor - 1];
    const next = remaining[cursor + 1];
    return `
      <section class="view deck-screen" aria-labelledby="properties-title">
        <div class="selected-customer-bar" aria-label="選択中の顧客">
          <div class="selection-copy"><span class="selection-dot" aria-hidden="true"></span><div><span class="selection-label">この顧客に提案</span><strong class="selection-name">${escapeHTML(selected.name)}</strong></div></div>
          <button class="ghost-button compact-button" type="button" data-action="go-customers">変更</button>
        </div>
        <header class="deck-header">
          <h1 id="properties-title" class="deck-title">候補カード <span class="deck-count">${remaining.length}</span></h1>
          <button class="deck-icon-button" type="button" data-action="edit-preference" data-preference="propertyFields" aria-label="カードの表示項目を編集"><span aria-hidden="true">|||</span></button>
        </header>
        <div class="deck-chips" role="group" aria-label="並び替えと絞り込み">
          <button class="deck-chip round ${activeDeckFilterCount() ? "on" : ""}" type="button" data-action="open-deck-filters" aria-label="絞り込み${activeDeckFilterCount() ? `（${activeDeckFilterCount()}件適用中）` : ""}"><span aria-hidden="true">⌕</span>${activeDeckFilterCount() ? `<span class="chip-dot" aria-hidden="true"></span>` : ""}</button>
          ${DECK_SORTS.map((sort) => `<button class="deck-chip ${runtime.deckSort === sort.id ? "on" : ""}" type="button" data-action="deck-sort" data-sort="${sort.id}" aria-pressed="${runtime.deckSort === sort.id}">${escapeHTML(sort.label)}</button>`).join("")}
        </div>
        ${renderFreshnessWarning("空室・鍵・金額は提案前に再確認してください")}
        ${current ? `
          <div class="deck-stage" data-deck-stage aria-live="polite">
            ${previous ? renderPropertyCard(previous, "prev", selected.id) : ""}
            ${next ? renderPropertyCard(next, "next", selected.id) : ""}
            ${renderPropertyCard(current, "current", selected.id)}
          </div>
          <p class="deck-position">${cursor + 1} / ${remaining.length}件目　保存 ${likedCount} · Skip ${skippedCount}${hiddenByFilter ? ` · 絞り込みで${hiddenByFilter}件非表示` : ""}</p>
          ${likedCount ? "" : '<p class="deck-hint">カードを下へスワイプすると、ここに保存されます</p>'}
          ${renderDeckPile(likedProperties, selected)}` : adapterState.empty ? renderPropertyNoResults(selected) : hiddenByFilter ? renderDeckFilteredOut(hiddenByFilter) : renderPropertyEmpty(selected, { liked: likedCount, skipped: skippedCount })}
        ${renderDeckMenu()}
      </section>`;
  }

  /**
   * 保存したカードが画面下へ積み上がっていく様子を出す。
   * 件数ラベルは重ねず（束の見え方を邪魔するため）、束そのものを一覧への入口にする。
   */
  function renderDeckPile(likedProperties, selected) {
    const slabs = [...likedProperties].reverse().slice(0, 3);
    return `
      <div class="deck-pile ${slabs.length ? "" : "is-empty"}" data-deck-tray>
        ${slabs.map((property, index) => `<span class="pile-slab" style="--i:${index}" aria-hidden="true"><img src="${escapeHTML(propertyVisual(property).url)}" alt="" loading="eager" referrerpolicy="no-referrer" draggable="false" /></span>`).join("")}
        <button class="pile-open" type="button" data-action="review-candidates" data-id="${selected.id}" aria-label="保存済み${likedProperties.length}件を確認する"></button>
      </div>`;
  }

  /** 固定フッターを隠す代わりの移動導線。物件画面を広く使うため右下に置く。 */
  function renderDeckMenu() {
    const destinations = [
      ["today", "今日", "✓"],
      ["customers", "顧客", "♙"],
      ["viewings", "内見", "⌖"],
      ["cases", "案件", "▤"],
    ];
    return `
      <div class="deck-nav ${runtime.deckMenuOpen ? "is-open" : ""}" data-deck-nav>
        ${runtime.deckMenuOpen ? '<button class="deck-nav-scrim" type="button" data-action="toggle-deck-menu" aria-label="メニューを閉じる"></button>' : ""}
        <div class="deck-nav-items" role="menu" ${runtime.deckMenuOpen ? "" : "hidden"}>
          ${destinations.map(([tab, label, icon]) => `<button class="deck-nav-item" type="button" role="menuitem" data-action="go-tab" data-tab-target="${tab}"><span class="deck-nav-icon" aria-hidden="true">${icon}</span>${label}</button>`).join("")}
        </div>
        <button class="deck-fab" type="button" data-action="toggle-deck-menu" aria-expanded="${runtime.deckMenuOpen}" aria-haspopup="menu" aria-label="${runtime.deckMenuOpen ? "メニューを閉じる" : "ほかの画面へ移動"}"><span aria-hidden="true">${runtime.deckMenuOpen ? "×" : "≡"}</span></button>
      </div>`;
  }

  function renderDeckFilteredOut(hiddenByFilter) {
    return `<div class="empty-state"><div class="empty-state-inner"><div class="empty-icon" aria-hidden="true">⌕</div><h2 class="empty-title">絞り込みで全件が隠れています</h2><p class="empty-copy">条件に合う未確認の物件が${hiddenByFilter}件あります。絞り込みを外すと表示されます。</p><button class="primary-button" type="button" data-action="clear-deck-filters">絞り込みを外す</button></div></div>`;
  }

  function clampDeckCursor(length) {
    if (length <= 0) {
      runtime.deckCursor = 0;
      return 0;
    }
    runtime.deckCursor = Math.max(0, Math.min(runtime.deckCursor, length - 1));
    return runtime.deckCursor;
  }

  function moveDeckCursor(step) {
    const selected = customerById(state.selectedCustomerId);
    if (!selected || runtime.decisionPending) return;
    const remaining = matchingPropertiesForCustomer(selected.id).filter(
      (property) => effectiveStatusForProperty(selected.id, property.id) === "unreviewed" && passesDeckFilters(property),
    );
    const nextCursor = runtime.deckCursor + step;
    if (nextCursor < 0 || nextCursor > remaining.length - 1) return;
    runtime.deckCursor = nextCursor;
    runtime.deckSlide = step > 0 ? "next" : "prev";
    renderApp();
  }

  function renderPropertyField(field, property, index) {
    const [walk, layout] = propertyPlaceParts(property);
    const values = {
      listing: ["募集状況", property.listingStatus],
      ad: ["AD・社内限定", adBreakdown(property).label],
      rent: ["賃料", yen(property.rentYen)],
      management: ["管理費／共益費", yen(property.managementFeeYen)],
      address: ["場所", walk],
      layout: ["間取り", layout],
      viewing: ["内見可否", property.viewingAvailable],
      moveIn: ["入居可能日", property.moveInAt],
      initialCost: ["初期費用概算", yen(property.initialCostYen)],
      note: ["備考", property.publicNote],
    };
    const value = values[field];
    if (!value) return "";
    const wide = field === "note" || field === "initialCost";
    const half = field === "address" || field === "layout";
    const toneClass = field === "listing" ? ` tone-${listingTone(property.listingStatus)}` : "";
    return `<div class="property-data${wide ? " wide" : ""}${half ? " half" : ""}${index === 0 ? " emphasized" : ""}${toneClass}"><span class="detail-label">${value[0]}${index === 0 ? " · 強調" : ""}</span><strong class="detail-value">${escapeHTML(value[1])}</strong></div>`;
  }

  /**
   * カード表面は要点だけに絞る（物件名・賃料・間取り・募集状況・駅徒歩・マッチ度・鮮度）。
   * 賃料以外の金額、AD、備考、合う理由は詳細シートへ送り、面を写真で使い切る。
   */
  function renderPropertyCard(property, slot, customerId) {
    const isCurrent = slot === "current";
    const candidate = candidateByIds(customerId, property.id);
    const stale = propertyIsStale(property);
    const [walk, layout] = propertyPlaceParts(property);
    const statusTone = listingTone(property.listingStatus);
    const visual = propertyVisual(property);
    return `
      <article class="property-card deck-card ${slot} ${isCurrent ? "top-card" : ""}" data-property-card data-property-slot="${slot}" data-property-id="${property.id}" data-listing-status="${property.listingStatus}" ${isCurrent ? 'aria-label="現在の候補物件"' : 'aria-hidden="true"'}>
        <img class="card-photo ${visual.kind}" src="${escapeHTML(visual.url)}" alt="${escapeHTML(property.name)}の${visual.label}" loading="${isCurrent ? "eager" : "lazy"}" referrerpolicy="no-referrer" draggable="false" />
        <span class="card-scrim" aria-hidden="true"></span>
        <span class="swipe-badge save" aria-hidden="true">保存</span>
        <div class="card-top">
          <span class="match-badge">マッチ度 ${clampPercent(candidate?.matchScore)}%</span>
          <span class="freshness-chip ${stale ? "stale" : ""}">${stale ? "⚠ " : ""}更新 ${escapeHTML(relativeSourceTime(property.sourceUpdatedAt))}</span>
        </div>
        <div class="card-foot">
          <span class="status-pill ${statusTone}">${escapeHTML(property.listingStatus)}</span>
          <h2 class="card-name">${escapeHTML(property.name)}</h2>
          <p class="card-price">${escapeHTML(manYen(property.rentYen))}<span class="card-layout"> / ${escapeHTML(layout || "間取り 未確認")}</span></p>
          <p class="card-walk">${escapeHTML(walk || "所在 未確認")}　内見 ${escapeHTML(property.viewingAvailable)}</p>
        </div>
        ${isCurrent ? `<button class="card-open" type="button" data-action="open-property-detail" data-id="${property.id}" aria-label="${escapeHTML(property.name)}の詳細を開く"><span class="card-open-label">タップで詳細</span></button>
        <div class="card-decide">
          <button class="card-action skip" type="button" data-action="property-skip" data-id="${property.id}" aria-label="この物件をSkipする"><span aria-hidden="true">✕</span></button>
          <button class="card-action save" type="button" data-action="property-like" data-id="${property.id}" ${property.listingStatus === "募集終了" ? "disabled" : ""} aria-label="${property.listingStatus === "募集終了" ? "募集終了のため保存できません" : "この物件を候補へ保存する"}">${property.listingStatus === "募集終了" ? '<span aria-hidden="true">—</span>' : SAVE_ICON}</button>
        </div>` : ""}
      </article>`;
  }

  function talkMessages(customerId) {
    if (!runtime.talks.has(customerId)) runtime.talks.set(customerId, []);
    return runtime.talks.get(customerId);
  }

  function replyDraftFor(customer) {
    return `${customer.name.split(" ")[0]}さま、お問い合わせありがとうございます。ご希望のエリアと入居時期に合うお部屋を整理してお送りします。通勤先の最寄り駅と、ご希望の賃料上限を教えていただけますか？`;
  }

  /**
   * 公式LINEのトーク。ここは画面の見え方を確定させるためのモックで、
   * 送信は端末内の記録に留め、外部のMessaging APIは呼ばない。
   */
  function openTalk(customerId) {
    const customer = customerById(customerId);
    if (!customer) return;
    runtime.talkCustomerId = customerId;
    const messages = talkMessages(customerId);
    const content = `
      <header class="sheet-header">
        <div><p class="eyebrow">LINE TALK</p><h2 id="talk-title" class="sheet-title">${escapeHTML(customer.name)}</h2><p class="sheet-subtitle">公式LINEのトーク · ${escapeHTML(customer.status)}</p></div>
        <button class="icon-button" type="button" data-action="close-modal" aria-label="閉じる">×</button>
      </header>
      <div class="sheet-content talk-content">
        <div class="reply-safety">モックです。外部のLINEへは送信せず、この端末の記録にだけ残します。</div>
        <ol class="talk-log">
          ${messages.map((message) => `
            <li class="talk-row ${message.direction}">
              <div class="talk-bubble">${escapeHTML(message.body)}</div>
              <p class="talk-meta">${escapeHTML(message.at)}${message.direction === "out" ? ` · ${message.status === "sent" ? "送信済み（モック）" : "下書き"}` : " · 受信"}</p>
            </li>`).join("")}
        </ol>
        ${messages.length ? "" : '<p class="small-copy">まだやり取りがありません。</p>'}
      </div>
      <form id="talk-form" class="talk-form" data-id="${customer.id}">
        <div class="talk-tools">
          <button class="ghost-button compact-button" type="button" data-action="talk-insert-draft" data-id="${customer.id}">AI下書きを入れる</button>
          <button class="ghost-button compact-button" type="button" data-action="talk-mock-receive" data-id="${customer.id}">受信をテスト</button>
        </div>
        <label class="sr-only" for="talk-body">返信本文</label>
        <textarea id="talk-body" name="body" class="talk-input" rows="3" placeholder="返信を入力（送信前に必ず内容を確認してください）">${escapeHTML(runtime.talkDraft)}</textarea>
        <div class="talk-send">
          <p class="tiny-copy">鍵・AD・管理会社メモなどの社内限定情報は送信できません</p>
          <button class="primary-button" type="submit">確認して送信</button>
        </div>
      </form>`;
    openSheet(content, "talk-title");
    window.requestAnimationFrame(() => {
      const log = modalRoot.querySelector(".talk-content");
      if (log) log.scrollTop = log.scrollHeight;
    });
  }

  function openDeckFilters() {
    const content = `
      <header class="sheet-header"><div><p class="eyebrow">FILTER</p><h2 id="deck-filter-title" class="sheet-title">絞り込み</h2><p class="sheet-subtitle">仕分けに出す物件を絞ります。判断済みの結果は変わりません</p></div><button class="icon-button" type="button" data-action="close-modal" aria-label="閉じる">×</button></header>
      <div class="sheet-content">
        <div class="checkbox-list">
          ${DECK_FILTERS.map((filter) => `
            <button class="filter-toggle ${runtime.deckFilters[filter.id] ? "on" : ""}" type="button" data-action="toggle-deck-filter" data-filter="${filter.id}" aria-pressed="${runtime.deckFilters[filter.id]}">
              <span class="filter-check" aria-hidden="true">${runtime.deckFilters[filter.id] ? "✓" : ""}</span>
              <span class="filter-main"><span class="filter-label">${escapeHTML(filter.label)}</span><span class="filter-copy">${escapeHTML(filter.copy)}</span></span>
            </button>`).join("")}
        </div>
      </div>
      <footer class="sheet-footer">
        <button class="ghost-button" type="button" data-action="clear-deck-filters">すべて外す</button>
        <button class="primary-button" type="button" data-action="close-modal">この条件で見る</button>
      </footer>`;
    openSheet(content, "deck-filter-title");
  }

  function openPropertyDetail(propertyId) {
    const property = propertyById(propertyId);
    const customer = customerById(state.selectedCustomerId);
    if (!property || !customer) return;
    const candidate = candidateByIds(customer.id, property.id);
    const stale = propertyIsStale(property);
    const sold = property.listingStatus === "募集終了";
    const content = `
      <header class="sheet-header"><div><p class="eyebrow">PROPERTY DETAIL</p><h2 id="property-detail-title" class="sheet-title">${escapeHTML(property.name)}</h2><p class="sheet-subtitle">${escapeHTML(property.listingStatus)} ${escapeHTML(listedDate(property.listedAt))} · 更新 ${escapeHTML(relativeSourceTime(property.sourceUpdatedAt))}</p></div><button class="icon-button" type="button" data-action="close-modal" aria-label="閉じる">×</button></header>
      <div class="sheet-content">
        ${stale ? '<div class="freshness-warning" role="status"><strong>情報の鮮度が基準を超えています</strong><span>空室再確認のうえで提案してください</span></div>' : ""}
        <div class="property-data-grid">
          ${PROPERTY_FIELD_KEYS.map((field, fieldIndex) => renderPropertyField(field, property, fieldIndex + 1)).join("")}
        </div>
        <section class="match-block" aria-label="マッチ度">
          <div class="match-head">
            <span class="match-score">${clampPercent(candidate?.matchScore)}<span class="match-unit">%</span></span>
            <div><p class="match-title">マッチ度</p><p class="match-sub">${escapeHTML(customer.name)}さんの希望条件との一致</p></div>
          </div>
          ${(candidate?.matchReasons || []).length
            ? `<ul class="match-list">${candidate.matchReasons.map((reason) => `<li>${escapeHTML(MATCH_REASON_COPY[reason] || `${reason}が希望に合っています`)}</li>`).join("")}</ul>`
            : '<p class="small-copy">一致した条件はまだ算出できていません。</p>'}
        </section>
        <section class="detail-section" aria-labelledby="internal-title">
          <div class="detail-section-head"><h3 id="internal-title" class="detail-section-title">社内限定</h3><span class="mini-badge">顧客返信には含めません</span></div>
          <p class="small-copy">鍵：${escapeHTML(property.internal.keyInfo)}</p>
          <p class="small-copy">管理会社：${escapeHTML(property.internal.managementCompanyNote)}</p>
        </section>
      </div>
      <footer class="sheet-footer">
        <button class="ghost-button" type="button" data-action="property-skip" data-id="${property.id}">Skip</button>
        <button class="primary-button" type="button" data-action="property-like" data-id="${property.id}" ${sold ? "disabled" : ""}>${sold ? "募集終了" : "候補へ保存"}</button>
      </footer>`;
    openSheet(content, "property-detail-title");
  }

  function renderPropertyEmpty(selected, decisions) {
    return `<div class="empty-state"><div class="empty-state-inner"><div class="empty-icon" aria-hidden="true">✓</div><h2 class="empty-title">20件の確認が完了しました</h2><p class="empty-copy">${escapeHTML(selected.name)}さんの仕分け結果を比較して、返信案を確認できます。</p><button class="primary-button" type="button" data-action="review-candidates" data-id="${selected.id}">保存候補を比較</button>${decisions.skipped ? '<button class="ghost-button" type="button" data-action="relax-condition" style="margin-top:8px">Skipした物件を再確認</button>' : ""}<p class="small-copy" style="margin-top:12px">保存 ${decisions.liked}件 · Skip ${decisions.skipped}件</p></div></div>`;
  }

  function renderPropertyNoResults(selected) {
    return `<div class="empty-state"><div class="empty-state-inner"><div class="empty-icon" aria-hidden="true">⌕</div><h2 class="empty-title">条件に合う物件が0件です</h2><p class="empty-copy">${escapeHTML(selected.name)}さんの絶対条件を保ったまま、駅徒歩または築年数を少し広げる案を確認してください。</p><button class="primary-button" type="button" data-action="retry-property-search">条件緩和案を確認</button><p class="small-copy" style="margin-top:12px">絶対条件は自動で緩めません</p></div></div>`;
  }

  function renderViewings() {
    const filtered = Viewing.filter((viewing) => viewing.range === runtime.viewingRange);
    const todayViewings = Viewing.filter((viewing) => viewing.range === "today").sort((a, b) => a.routeOrder - b.routeOrder);
    return `
      <section class="view" aria-labelledby="viewings-title">
        <header class="view-header"><div><p class="eyebrow">VIEWING DESK</p><h1 id="viewings-title" class="page-title">内見</h1></div><span class="date-chip">${filtered.length}組</span></header>
        ${renderFreshnessWarning("空室と鍵は、出発前に管理会社へ再確認してください")}
        <div class="segmented-control" aria-label="内見期間">
          <button class="segmented-button" type="button" data-action="viewing-range" data-range="today" aria-pressed="${runtime.viewingRange === "today"}">今日</button>
          <button class="segmented-button" type="button" data-action="viewing-range" data-range="week" aria-pressed="${runtime.viewingRange === "week"}">今週</button>
        </div>
        ${runtime.viewingRange === "today" ? `
          <section class="section" aria-labelledby="route-heading">
            <div class="section-heading"><h2 id="route-heading" class="section-title">推奨巡回順</h2><span class="mini-badge">移動 約25分</span></div>
            <div class="card route-card"><div class="route-head"><p class="small-copy">移動時間と鍵の受取を加味</p><span class="status-pill success">最短</span></div><ol class="route-list">
              ${todayViewings.map((viewing) => {
                const property = propertyById(viewing.propertyId);
                return `<li class="route-item"><span class="route-number">${viewing.routeOrder}</span><div><p class="route-title">${escapeHTML(property.name)}</p><p class="route-meta">${escapeHTML(viewing.time)} · ${escapeHTML(viewing.meetingPlace)}</p></div></li>`;
              }).join("")}
            </ol></div>
          </section>` : ""}
        <section class="section" aria-labelledby="viewing-list-heading">
          <div class="section-heading"><h2 id="viewing-list-heading" class="section-title">${runtime.viewingRange === "today" ? "今日" : "今週"}の予定</h2></div>
          ${filtered.map(renderViewingCard).join("") || `<div class="empty-state" style="min-height:260px"><div class="empty-state-inner"><div class="empty-icon">⌖</div><h3 class="empty-title">内見予定はありません</h3></div></div>`}
        </section>
      </section>`;
  }

  function renderViewingCard(viewing) {
    const customer = customerById(viewing.customerId);
    const property = propertyById(viewing.propertyId);
    const linkedCase = Case.find((item) => item.customerId === viewing.customerId && item.propertyId === viewing.propertyId);
    const alreadyApplying = linkedCase && stageAtOrBeyond(linkedCase.stage, "申込準備");
    const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(viewing.meetingPlace)}`;
    return `<article class="card viewing-card">
      <div class="card-body">
        <div class="viewing-head">
          <time class="viewing-time">${escapeHTML(viewing.time)}<small>${escapeHTML(viewing.date)}</small></time>
          <div class="viewing-main"><div class="row" style="gap:6px;flex-wrap:wrap"><span class="status-pill ${viewing.status === "確定" ? "success" : "warning"}">${escapeHTML(viewing.status)}</span>${viewing.impression ? '<span class="status-pill neutral">感想あり</span>' : ""}</div><h3 class="card-title" style="margin-top:7px">${escapeHTML(property.name)}</h3><p class="person-meta">${escapeHTML(customer.name)}</p></div>
        </div>
        <div class="check-grid">
          <button class="check-button ${viewing.vacancyConfirmed ? "done" : ""}" type="button" data-action="toggle-vacancy" data-id="${viewing.id}"><span class="check-mark" aria-hidden="true">${viewing.vacancyConfirmed ? "✓" : ""}</span><span>空室再確認<br /><small>${viewing.vacancyConfirmed ? "確認済み" : "要確認"}</small></span></button>
          <button class="check-button ${viewing.keyConfirmed ? "done" : ""}" type="button" data-action="toggle-key" data-id="${viewing.id}"><span class="check-mark" aria-hidden="true">${viewing.keyConfirmed ? "✓" : ""}</span><span>鍵確認 <span class="internal-badge">社内限定</span><br /><small>${viewing.keyConfirmed ? "確認済み" : "要確認"}</small></span></button>
        </div>
        <p class="tiny-copy" style="margin-top:8px">鍵メモ：${escapeHTML(viewing.keyNote)}</p>
        <div class="meeting-box"><div><span class="detail-label">集合場所</span><strong class="detail-value">${escapeHTML(viewing.meetingPlace)}</strong></div><a class="maps-link" href="${mapsUrl}" target="_blank" rel="noreferrer" aria-label="${escapeHTML(viewing.meetingPlace)}をMapsで開く">Maps</a></div>
        <div class="card-actions"><button class="ghost-button" type="button" data-action="open-feedback" data-id="${viewing.id}">感想入力</button><button class="primary-button" type="button" data-action="start-application" data-id="${viewing.id}">${alreadyApplying ? `${escapeHTML(linkedCase.stage)}の案件を見る` : "申込へ進む"}</button></div>
      </div>
    </article>`;
  }

  function renderCases() {
    const stages = [
      ["追客中", "#80a995"],
      ["内見調整", "#f3a36f"],
      ["申込準備", "#d99655"],
      ["審査中", "#8e93c8"],
      ["契約準備", "#6da9ba"],
      ["契約済", "#6a9f83"],
    ];
    return `
      <section class="view" aria-labelledby="cases-title">
        <header class="view-header"><div><p class="eyebrow">DEAL PIPELINE</p><h1 id="cases-title" class="page-title">案件</h1></div><span class="date-chip">全 ${Case.length}件</span></header>
        <div class="summary-grid" aria-label="案件概要"><div class="metric-card"><span class="metric-label">期限24時間以内</span><strong class="metric-value">${Case.filter((item) => { const due = Date.parse(item.dueAt); return Number.isFinite(due) && due >= MOCK_NOW && due <= MOCK_NOW + 24 * 60 * 60 * 1_000; }).length}<span class="metric-unit">件</span></strong></div><div class="metric-card"><span class="metric-label">申込以降</span><strong class="metric-value">${Case.filter((item) => stageAtOrBeyond(item.stage, "申込準備")).length}<span class="metric-unit">件</span></strong></div></div>
        <section class="section" aria-labelledby="pipeline-heading">
          <div class="section-heading"><h2 id="pipeline-heading" class="section-title">ステージ別</h2><span class="section-note">縦に進行</span></div>
          ${stages.map(([stage, color], index) => {
            const cases = Case.filter((item) => item.stage === stage);
            return `<details class="stage-accordion" style="--stage-color:${color}" ${index === 1 ? "open" : ""}>
              <summary class="stage-summary"><span class="stage-rail-mark" aria-hidden="true"></span><span class="stage-summary-main"><span class="stage-name">${stage}</span><span class="stage-count">${cases.length}件</span></span><span class="stage-toggle" aria-hidden="true">＋</span></summary>
              <div class="stage-content">${cases.map(renderCaseCard).join("") || '<p class="small-copy">このステージの案件はありません。</p>'}</div>
            </details>`;
          }).join("")}
        </section>
      </section>`;
  }

  function renderCaseCard(caseItem) {
    const customer = customerById(caseItem.customerId);
    const property = propertyById(caseItem.propertyId);
    const dueLabel = dueCalendarLabel(caseItem.dueAt);
    const dueTimestamp = Date.parse(caseItem.dueAt);
    const urgent = Number.isFinite(dueTimestamp) && dueTimestamp <= MOCK_NOW + 24 * 60 * 60 * 1_000;
    return `<article class="case-card">
      <div class="case-line"><p class="case-customer">${escapeHTML(customer.name)}</p><span class="status-pill ${urgent ? "urgent" : "neutral"}">${escapeHTML(dueLabel)}</span></div>
      <p class="case-property">${escapeHTML(property.name)}</p>
      <div class="case-next"><span class="case-next-label">次アクション</span><strong class="case-next-action">${escapeHTML(caseItem.nextAction)}</strong></div>
      <div class="case-status-grid"><div class="case-status"><span class="status-label">書類</span><strong class="status-value">${escapeHTML(caseItem.documentStatus)}</strong></div><div class="case-status"><span class="status-label">申込状態</span><strong class="status-value">${escapeHTML(caseItem.applicationStatus)}</strong></div></div>
      <p class="case-history">履歴：${escapeHTML(dueCalendarLabel(caseItem.updatedAt))} · 佐藤が更新</p>
    </article>`;
  }

  function openSheet(content, labelId) {
    runtime.previousFocus = document.activeElement;
    modalRoot.innerHTML = `<div class="overlay"><section class="sheet" role="dialog" aria-modal="true" aria-labelledby="${labelId}"><div class="sheet-handle" aria-hidden="true"></div>${content}</section></div>`;
    document.body.style.overflow = "hidden";
    window.requestAnimationFrame(() => modalRoot.querySelector("button, input, textarea, select")?.focus());
  }

  function closeModal() {
    if (!modalRoot.innerHTML) return;
    modalRoot.innerHTML = "";
    document.body.style.overflow = "";
    if (runtime.previousFocus instanceof HTMLElement && runtime.previousFocus.isConnected) runtime.previousFocus.focus();
    runtime.previousFocus = null;
    runtime.preferenceDraft = null;
  }

  function openCustomerDetail(customerId) {
    const customer = customerById(customerId);
    if (!customer) return;
    const condition = SearchCondition.find((item) => item.id === customer.searchConditionId);
    const liked = candidateIdsForCustomer(customer.id).map(propertyById).filter(Boolean);
    const statusLabels = { confirmed: "確定", inferred: "AI推定", unknown: "未確認" };
    const content = `
      <header class="sheet-header"><div><p class="eyebrow">CUSTOMER DETAIL</p><h2 id="customer-detail-title" class="sheet-title">${escapeHTML(customer.name)}</h2><p class="sheet-subtitle">${escapeHTML(customer.status)} · 担当 ${escapeHTML(customer.assignedTo || "未割当")}</p></div><button class="icon-button" type="button" data-action="close-modal" aria-label="閉じる">×</button></header>
      <div class="sheet-content">
        <section class="detail-section" aria-labelledby="condition-section-title"><div class="detail-section-head"><h3 id="condition-section-title" class="detail-section-title">AI条件整理</h3><span class="mini-badge">確定 / 推定 / 未確認</span></div><ul class="condition-list">${condition.items.map((item) => `<li class="condition-item"><span class="condition-dot ${item.status}" aria-hidden="true"></span><div><p class="condition-title">${escapeHTML(item.label)} <span class="tag ${item.status === "confirmed" ? "success" : item.status === "inferred" ? "warning" : "neutral"}">${statusLabels[item.status]}</span></p><p class="condition-copy">${escapeHTML(item.value)}</p></div></li>`).join("")}</ul></section>
        <section class="detail-section" aria-labelledby="line-summary-title"><div class="detail-section-head"><h3 id="line-summary-title" class="detail-section-title">LINE会話と要約</h3><span class="mini-badge">会話から要約</span></div><blockquote class="summary-quote">${escapeHTML(customer.lineSummary)}</blockquote>${talkMessages(customer.id).length ? `<ol class="conversation-list">${talkMessages(customer.id).slice(-3).map((message) => `<li><time>${escapeHTML(message.at)}</time><span>${message.direction === "in" ? "顧客" : "営業"}</span><p>${escapeHTML(message.body)}</p></li>`).join("")}</ol>` : '<p class="small-copy">まだやり取りがありません。</p>'}<button class="ghost-button wide-button" type="button" data-action="open-talk" data-id="${customer.id}" style="margin-top:10px">トークを開いて返信する</button></section>
        <section class="detail-section" aria-labelledby="liked-title"><div class="detail-section-head"><h3 id="liked-title" class="detail-section-title">Like物件</h3><span class="count-badge">${liked.length}</span></div>${liked.length ? `<ul class="liked-list">${liked.slice(0, 3).map((property) => { const candidate = candidateByIds(customer.id, property.id); return `<li class="liked-item"><span class="liked-thumb"><img src="${escapeHTML(property.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" /></span><div class="person-main"><p class="person-name">${escapeHTML(property.name)}</p><p class="person-meta">${yen(property.rentYen)} · マッチ度 ${clampPercent(candidate?.matchScore)}%</p></div></li>`; }).join("")}</ul>` : '<p class="small-copy">まだLikeした物件はありません。</p>'}</section>
        <section class="detail-section" aria-labelledby="progress-title"><div class="detail-section-head"><h3 id="progress-title" class="detail-section-title">進捗</h3><span class="stage-pill">${escapeHTML(customer.status)}</span></div><div class="progress-track" aria-label="進捗 ${clampPercent(customer.progress)}%"><div class="progress-value" style="width:${clampPercent(customer.progress)}%"></div></div><div class="progress-labels"><span>初回対応</span><span>物件提案</span><span>内見</span><span>申込</span><span>契約</span></div></section>
      </div>
      <footer class="sheet-footer">
        ${customer.unassigned ? `<button class="ghost-button" type="button" data-action="claim-customer" data-id="${customer.id}">担当になる</button>` : `<button class="ghost-button" type="button" data-action="open-talk" data-id="${customer.id}">トークを開く</button>`}
        <button class="primary-button" type="button" data-action="select-customer" data-id="${customer.id}">${state.selectedCustomerId === customer.id ? "選択中 · 物件を見る" : "この顧客で物件を見る"}</button>
      </footer>`;
    openSheet(content, "customer-detail-title");
  }

  function openPreferenceEditor(type, focusId = null) {
    const isProperty = type === "propertyFields";
    const validKeys = isProperty ? PROPERTY_FIELD_KEYS : WIDGET_KEYS;
    const available = isProperty ? DisplayPreference.availablePropertyFields : DisplayPreference.availableWidgets;
    if (!runtime.preferenceDraft || runtime.preferenceDraft.type !== type) {
      const enabled = new Set(state.displayPreference[type]);
      runtime.preferenceDraft = {
        type,
        order: [...state.displayPreference[type], ...validKeys.filter((key) => !enabled.has(key))],
        enabled,
      };
    }
    const draft = runtime.preferenceDraft;
    const content = `
      <form id="preference-form" data-preference="${type}">
        <header class="sheet-header"><div><p class="eyebrow">DISPLAY SETTINGS</p><h2 id="preference-title" class="sheet-title">${isProperty ? "物件カードの表示を編集" : "今日の表示を編集"}</h2><p class="sheet-subtitle">表示の有無と順番を営業ごとに保存します</p></div><button class="icon-button" type="button" data-action="close-modal" aria-label="閉じる">×</button></header>
        <div class="sheet-content"><div class="checkbox-list">${draft.order.map((itemId, index) => {
          const item = available.find((candidate) => candidate.id === itemId);
          return `<div class="checkbox-card"><label class="preference-check"><input type="checkbox" name="preference-item" value="${item.id}" ${draft.enabled.has(item.id) ? "checked" : ""} /><span class="checkbox-main"><span class="checkbox-title">${escapeHTML(item.label)}</span><span class="checkbox-copy">${escapeHTML(item.description)}</span></span></label><span class="order-controls"><button class="order-button" type="button" data-action="move-preference" data-id="${item.id}" data-direction="-1" ${index === 0 ? "disabled" : ""} aria-label="${escapeHTML(item.label)}を上へ">↑</button><button class="order-button" type="button" data-action="move-preference" data-id="${item.id}" data-direction="1" ${index === draft.order.length - 1 ? "disabled" : ""} aria-label="${escapeHTML(item.label)}を下へ">↓</button></span></div>`;
        }).join("")}</div></div>
        <footer class="sheet-footer"><button class="ghost-button" type="button" data-action="close-modal">キャンセル</button><button class="primary-button" type="submit">表示を保存</button></footer>
      </form>`;
    const openSheetElement = modalRoot.querySelector(".sheet");
    if (openSheetElement) {
      openSheetElement.innerHTML = `<div class="sheet-handle" aria-hidden="true"></div>${content}`;
    } else {
      openSheet(content, "preference-title");
    }
    if (focusId) {
      window.requestAnimationFrame(() => modalRoot.querySelector(`[data-action="move-preference"][data-id="${CSS.escape(focusId)}"]`)?.focus());
    }
  }

  function openReplyDraft() {
    const sent = runtime.sentReplies.get("c2");
    if (sent) {
      const content = `
        <header class="sheet-header"><div><p class="eyebrow">APPROVED REPLY</p><h2 id="reply-title" class="sheet-title">送信記録</h2><p class="sheet-subtitle">石井 健太さん · 営業確認済み</p></div><button class="icon-button" type="button" data-action="close-modal" aria-label="閉じる">×</button></header>
        <div class="sheet-content"><div class="reply-safety success-safety">営業が確認した本文だけをモック送信記録へ保存しています。</div><div class="reply-box"><p class="small-copy">${escapeHTML(sent.body)}</p></div><p class="tiny-copy">承認者 ${escapeHTML(sent.approvedBy)} · ${escapeHTML(sent.approvedAt)}</p></div>
        <footer class="sheet-footer single"><button class="ghost-button" type="button" data-action="close-modal">閉じる</button></footer>`;
      openSheet(content, "reply-title");
      return;
    }
    const content = `
      <form id="reply-form">
        <header class="sheet-header"><div><p class="eyebrow">AI REPLY DRAFT</p><h2 id="reply-title" class="sheet-title">返信案を確認</h2><p class="sheet-subtitle">石井 健太さんへの初回返信</p></div><button class="icon-button" type="button" data-action="close-modal" aria-label="閉じる">×</button></header>
        <div class="sheet-content">
          <div class="reply-safety">AIは自動送信しません。機密情報・社内限定情報は返信案に含めません。</div>
          <div class="reply-box"><div class="reply-meta"><span class="mini-badge">AI下書き</span><span class="tiny-copy">送信前に必ず確認</span></div><label class="form-group"><span class="form-label">返信内容</span><textarea class="form-textarea" name="reply">石井さま、お問い合わせありがとうございます。ご入居希望の時期に合うお部屋をお探しします。通勤先の最寄り駅と、ご希望の賃料上限を教えていただけますか？</textarea></label></div>
          <p class="small-copy">内容を修正できます。「確認して送信」を押すまで送信されません。</p>
        </div>
        <footer class="sheet-footer"><button class="ghost-button" type="button" data-action="close-modal">あとで確認</button><button class="primary-button" type="submit">確認して送信</button></footer>
      </form>`;
    openSheet(content, "reply-title");
  }

  function openFeedback(viewingId) {
    const viewing = Viewing.find((item) => item.id === viewingId);
    if (!viewing) return;
    const customer = customerById(viewing.customerId);
    const property = propertyById(viewing.propertyId);
    const content = `
      <form id="feedback-form" data-id="${viewing.id}">
        <header class="sheet-header"><div><p class="eyebrow">VIEWING FEEDBACK</p><h2 id="feedback-title" class="sheet-title">内見の感想</h2><p class="sheet-subtitle">${escapeHTML(customer.name)} · ${escapeHTML(property.name)}</p></div><button class="icon-button" type="button" data-action="close-modal" aria-label="閉じる">×</button></header>
        <div class="sheet-content">
          <label class="form-group"><span class="form-label">温度感</span><select class="form-select" name="temperature">${["前向き", "比較検討", "見送り"].map((value) => `<option ${viewing.temperature === value ? "selected" : ""}>${value}</option>`).join("")}</select></label>
          <label class="form-group"><span class="form-label">感想・気になった点</span><textarea class="form-textarea" name="impression" placeholder="日当たりが良い、収納が少ないなど">${escapeHTML(viewing.impression)}</textarea></label>
          <label class="form-group"><span class="form-label">次のアクション</span><select class="form-select" name="next">${["申込へ進む", "ほかの物件を提案", "条件を見直す", "追客予定を入れる"].map((value) => `<option ${viewing.nextAction === value ? "selected" : ""}>${value}</option>`).join("")}</select></label>
        </div>
        <footer class="sheet-footer"><button class="ghost-button" type="submit" data-submit-mode="save">感想を保存</button><button class="primary-button" type="submit" data-submit-mode="apply">申込へ進む</button></footer>
      </form>`;
    openSheet(content, "feedback-title");
  }

  function commitPropertyDecision(action, propertyId, customerId) {
    const customer = customerById(customerId);
    const property = propertyById(propertyId);
    if (!customer || !property || !["liked", "skipped"].includes(action)) {
      runtime.decisionPending = false;
      return;
    }
    if (action === "liked" && property.listingStatus === "募集終了") {
      runtime.decisionPending = false;
      renderApp();
      showToast("募集終了のため候補へ保存できません");
      return;
    }
    const result = applyPropertyDecision(state.decisions, customer.id, property.id, action);
    state.decisions = result.decisions;
    runtime.undo = result.undo;
    runtime.decisionPending = false;
    const saved = persistState();
    renderApp({ focusSelector: '[data-action="property-like"]' });
    showUndoToast(property, action, { storageFailed: !saved });
  }

  function animatePropertyDecision(action, propertyId) {
    if (runtime.decisionPending) return;
    const customerId = state.selectedCustomerId;
    if (!customerId) return;
    runtime.decisionPending = true;
    const card = document.querySelector(`.top-card[data-property-id="${CSS.escape(propertyId)}"]`);
    if (!card) {
      commitPropertyDecision(action, propertyId, customerId);
      return;
    }
    card.classList.add(action === "liked" ? "is-exiting-like" : "is-exiting-skip");
    window.setTimeout(() => commitPropertyDecision(action, propertyId, customerId), REDUCED_MOTION.matches ? 0 : 190);
  }

  function undoLastDecision() {
    const undo = runtime.undo;
    if (!undo) return;
    const result = undoPropertyDecision(state.decisions, undo);
    if (!result.restored) return;
    state.decisions = result.decisions;
    clearUndoToast();
    const saved = persistState();
    if (state.activeTab === "properties") renderApp({ focusSelector: '[data-action="property-like"]' });
    showToast(saved ? "直前の判断を元に戻しました" : "元に戻しましたが、端末へ保存できませんでした");
  }

  /**
   * デッキの操作。横は判断せず前後の候補へ送るだけ、下は候補へ保存する。
   * Skipは判断が消えると取り返しにくいので、ジェスチャーではなくトレイのボタンに置く。
   */
  function attachSwipeInteractions() {
    const stage = appView.querySelector("[data-deck-stage]");
    const card = stage?.querySelector(".top-card[data-property-card]");
    if (!stage || !card) return;

    if (runtime.deckSlide) {
      const from = runtime.deckSlide;
      runtime.deckSlide = null;
      if (!REDUCED_MOTION.matches) {
        card.classList.add(from === "next" ? "is-entering-left" : "is-entering-right");
        window.setTimeout(() => card.classList.remove("is-entering-left", "is-entering-right"), 220);
      }
    }

    const cards = [...stage.querySelectorAll("[data-property-card]")];
    let gesture = null;

    const resetStage = () => {
      stage.classList.remove("is-dragging");
      cards.forEach((item) => {
        item.style.removeProperty("--drag-x");
        item.style.removeProperty("--drag-y");
        item.style.removeProperty("--drag-scale");
      });
      const badge = card.querySelector(".swipe-badge.save");
      if (badge) badge.style.opacity = "0";
      appView.querySelector("[data-deck-tray]")?.classList.remove("is-target");
    };

    card.addEventListener("pointerdown", (event) => {
      if (!event.isPrimary || gesture || runtime.decisionPending) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      gesture = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startTime: event.timeStamp,
        dx: 0,
        dy: 0,
        axis: null,
      };
    });

    card.addEventListener("pointermove", (event) => {
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      const dx = event.clientX - gesture.startX;
      const dy = event.clientY - gesture.startY;
      const absX = Math.abs(dx);
      const absY = Math.abs(dy);
      if (!gesture.axis) {
        if (Math.max(absX, absY) < 10) return;
        gesture.axis = absX >= absY ? "horizontal" : "vertical";
        card.setPointerCapture?.(event.pointerId);
        stage.classList.add("is-dragging");
      }
      event.preventDefault();
      gesture.dx = dx;
      gesture.dy = dy;
      const width = Math.max(card.getBoundingClientRect().width, 1);
      const height = Math.max(card.getBoundingClientRect().height, 1);
      if (gesture.axis === "horizontal") {
        cards.forEach((item) => item.style.setProperty("--drag-x", `${dx}px`));
        return;
      }
      // 上方向へは動かさない（保存の取り消しに見えるため）
      const pulled = Math.max(0, dy);
      const progress = Math.min(1, pulled / (height * 0.22));
      card.style.setProperty("--drag-y", `${pulled}px`);
      card.style.setProperty("--drag-scale", String(1 - progress * 0.06));
      const badge = card.querySelector(".swipe-badge.save");
      if (badge) badge.style.opacity = String(progress);
      appView.querySelector("[data-deck-tray]")?.classList.toggle("is-target", progress >= 1);
      void width;
    });

    const finish = (event) => {
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      const current = gesture;
      gesture = null;
      if (!current.axis) {
        resetStage();
        return;
      }
      runtime.suppressCardClick = true;
      const rect = card.getBoundingClientRect();
      const elapsed = Math.max(16, event.timeStamp - current.startTime);
      if (current.axis === "horizontal") {
        const passed = Math.abs(current.dx) >= rect.width * 0.24 || (Math.abs(current.dx) / elapsed >= 0.5 && Math.abs(current.dx) >= 24);
        resetStage();
        if (passed) moveDeckCursor(current.dx < 0 ? 1 : -1);
        return;
      }
      const passed = current.dy >= rect.height * 0.22 || (current.dy / elapsed >= 0.5 && current.dy >= 40);
      if (!passed) {
        resetStage();
        return;
      }
      if (card.dataset.listingStatus === "募集終了") {
        resetStage();
        showToast("募集終了のため候補へ保存できません");
        return;
      }
      resetStage();
      animatePropertyDecision("liked", card.dataset.propertyId);
    };

    card.addEventListener("pointerup", finish);
    card.addEventListener("pointercancel", (event) => {
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      gesture = null;
      resetStage();
    });
  }

  function moveViewingToApplication(viewingId) {
    const viewing = Viewing.find((item) => item.id === viewingId);
    if (!viewing) return;
    let caseItem = Case.find((item) => item.customerId === viewing.customerId && item.propertyId === viewing.propertyId);
    if (caseItem && !isKnownCaseStage(caseItem.stage)) {
      closeModal();
      showToast("案件ステージを確認してから申込へ進めてください");
      return;
    }
    if (caseItem && stageAtOrBeyond(caseItem.stage, "申込準備")) {
      closeModal();
      state.activeTab = "cases";
      persistState();
      renderApp({ focusMain: true });
      showToast(`${caseItem.stage}の案件を表示しました`);
      return;
    }
    if (caseItem) {
      caseItem.stage = "申込準備";
      caseItem.nextAction = "申込情報を入力";
      caseItem.applicationStatus = "入力待ち";
    } else {
      caseItem = {
        id: `case${Case.length + 1}`,
        customerId: viewing.customerId,
        propertyId: viewing.propertyId,
        stage: "申込準備",
        nextAction: "申込情報を入力",
        dueAt: "2026-08-12T12:00:00+09:00",
        documentStatus: "本人確認書類 待ち",
        applicationStatus: "入力待ち",
        updatedAt: "2026-08-11T11:20:00+09:00",
      };
      Case.push(caseItem);
    }
    const customer = customerById(viewing.customerId);
    if (customer) {
      customer.status = "申込済";
      customer.stage = "申込準備";
      customer.progress = Math.max(customer.progress, 72);
    }
    viewing.status = "申込へ進行";
    caseItem.updatedAt = "2026-08-11T11:20:00+09:00";
    closeModal();
    state.activeTab = "cases";
    persistState();
    renderApp({ focusMain: true });
    showToast("申込準備へ進めました（モック）");
  }

  document.addEventListener("click", (event) => {
    if (event.target.classList.contains("overlay")) {
      closeModal();
      return;
    }
    const tab = event.target.closest("[data-tab]")?.dataset.tab;
    if (tab) {
      setActiveTab(tab);
      return;
    }
    const control = event.target.closest("[data-action]");
    if (!control) return;
    const { action, id, filter, range } = control.dataset;

    if (action === "close-modal") closeModal();
    if (action === "edit-preference") openPreferenceEditor(control.dataset.preference || "widgets");
    if (action === "move-preference" && runtime.preferenceDraft) {
      runtime.preferenceDraft.order = moveItem(runtime.preferenceDraft.order, id, Number(control.dataset.direction));
      openPreferenceEditor(runtime.preferenceDraft.type, id);
    }
    if (action === "open-reply") openReplyDraft();
    if (action === "open-customer") openCustomerDetail(id);
    if (action === "review-candidates") openCustomerDetail(id);
    if (action === "go-customers") setActiveTab("customers");
    if (action === "customer-filter") {
      runtime.customerFilter = filter;
      renderApp({ focusSelector: `[data-action="customer-filter"][data-filter="${CSS.escape(filter)}"]` });
    }
    if (action === "claim-customer") {
      const customer = customerById(id);
      if (customer) {
        customer.unassigned = false;
        customer.assignedTo = "佐藤";
        renderApp();
        openCustomerDetail(customer.id);
        showToast(`${customer.name}さんの担当になりました`);
      }
    }
    if (action === "select-customer") {
      if (runtime.undo) clearUndoToast();
      const changed = state.selectedCustomerId !== id;
      state.selectedCustomerId = id;
      state.activeTab = "properties";
      if (changed) runtime.deckCursor = 0;
      const saved = persistState();
      closeModal();
      renderApp({ focusMain: true });
      scrollViewToTop();
      if (!saved) showToast("選択した顧客をこの端末へ保存できませんでした");
    }
    if (action === "complete-today-action") {
      const todayAction = TodayAction.find((item) => item.id === id);
      if (todayAction && (todayAction.id === "ta2" || todayAction.id === "ta6") && isTodayActionDone(todayAction)) {
        showToast(todayAction.id === "ta2" ? "送信済みの返信は未完了へ戻せません" : "担当取得済みです");
        return;
      }
      if (runtime.completedTodayActions.has(id)) runtime.completedTodayActions.delete(id);
      else runtime.completedTodayActions.add(id);
      renderApp({ focusSelector: `[data-action="complete-today-action"][data-id="${CSS.escape(id)}"]` });
      showToast(runtime.completedTodayActions.has(id) ? "完了にしました" : "未完了に戻しました");
    }
    if (action === "deck-sort") {
      const sort = control.dataset.sort;
      if (DECK_SORTS.some((item) => item.id === sort) && runtime.deckSort !== sort) {
        runtime.deckSort = sort;
        runtime.deckCursor = 0;
        renderApp({ focusSelector: `[data-action="deck-sort"][data-sort="${CSS.escape(sort)}"]` });
        showToast(`${DECK_SORTS.find((item) => item.id === sort).label}に並び替えました`);
      }
    }
    if (action === "open-talk") openTalk(id);
    if (action === "talk-insert-draft") {
      const customer = customerById(id);
      const input = modalRoot.querySelector("#talk-body");
      if (customer && input) {
        runtime.talkDraft = replyDraftFor(customer);
        input.value = runtime.talkDraft;
        input.focus();
        showToast("AI下書きを入れました。送信前に必ず確認してください");
      }
    }
    if (action === "talk-mock-receive") {
      const messages = talkMessages(id);
      const sample = INCOMING_SAMPLES[runtime.incomingCount % INCOMING_SAMPLES.length];
      runtime.incomingCount += 1;
      messages.push({
        id: `${id}-in-${messages.length + 1}`,
        customerId: id,
        direction: "in",
        at: "たった今",
        body: sample,
        status: "received",
      });
      runtime.talkDraft = modalRoot.querySelector("#talk-body")?.value || "";
      openTalk(id);
      showToast("顧客からの受信を再現しました（Webhook相当）");
    }
    if (action === "open-deck-filters") openDeckFilters();
    if (action === "toggle-deck-filter") {
      const key = control.dataset.filter;
      if (key in runtime.deckFilters) {
        runtime.deckFilters[key] = !runtime.deckFilters[key];
        runtime.deckCursor = 0;
        renderApp();
        openDeckFilters();
      }
    }
    if (action === "clear-deck-filters") {
      Object.keys(runtime.deckFilters).forEach((key) => {
        runtime.deckFilters[key] = false;
      });
      runtime.deckCursor = 0;
      closeModal();
      renderApp();
      showToast("絞り込みを外しました");
    }
    if (action === "toggle-deck-menu") {
      runtime.deckMenuOpen = !runtime.deckMenuOpen;
      renderApp({ focusSelector: ".deck-fab" });
    }
    if (action === "go-tab") {
      runtime.deckMenuOpen = false;
      setActiveTab(control.dataset.tabTarget);
    }
    if (action === "open-property-detail") {
      // ドラッグの直後に発火するclickは詳細を開かない
      if (runtime.suppressCardClick) runtime.suppressCardClick = false;
      else openPropertyDetail(id);
    }
    if (action === "property-like" || action === "property-skip") {
      closeModal();
      animatePropertyDecision(action === "property-like" ? "liked" : "skipped", id);
    }
    if (action === "undo-decision") undoLastDecision();
    if (action === "relax-condition") {
      const customer = customerById(state.selectedCustomerId);
      if (!customer) return;
      const decisions = decisionRecord(customer.id);
      if (decisions.skipped.length) {
        if (runtime.undo) clearUndoToast();
        decisions.skipped = [];
        const saved = persistState();
        renderApp({ focusSelector: '[data-action="property-like"]' });
        showToast(saved ? "Skipした物件を未確認へ戻しました" : "未確認へ戻しましたが、端末へ保存できませんでした");
      } else {
        showToast("保存済み候補は維持されています");
      }
    }
    if (action === "retry-property-search") {
      showToast("駅徒歩・築年数の緩和案です。条件編集はITANDI接続工程で有効になります");
    }
    if (action === "viewing-range") {
      runtime.viewingRange = range;
      renderApp({ focusSelector: `[data-action="viewing-range"][data-range="${CSS.escape(range)}"]` });
    }
    if (action === "toggle-vacancy" || action === "toggle-key") {
      const viewing = Viewing.find((item) => item.id === id);
      if (viewing) {
        if (action === "toggle-vacancy") viewing.vacancyConfirmed = !viewing.vacancyConfirmed;
        else viewing.keyConfirmed = !viewing.keyConfirmed;
        renderApp({ focusSelector: `[data-action="${CSS.escape(action)}"][data-id="${CSS.escape(id)}"]` });
        showToast(action === "toggle-vacancy" ? "空室確認を更新しました" : "鍵確認を更新しました（社内限定）");
      }
    }
    if (action === "open-feedback") openFeedback(id);
    if (action === "start-application") moveViewingToApplication(id);
  });

  document.addEventListener("input", (event) => {
    if (event.target.id !== "customer-search") return;
    runtime.customerSearch = event.target.value;
    refreshCustomerResults();
  });

  document.addEventListener("change", (event) => {
    if (event.target.name !== "preference-item" || !runtime.preferenceDraft) return;
    if (event.target.checked) runtime.preferenceDraft.enabled.add(event.target.value);
    else runtime.preferenceDraft.enabled.delete(event.target.value);
  });

  document.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (event.target.id === "preference-form" && runtime.preferenceDraft) {
      const draft = runtime.preferenceDraft;
      const validKeys = draft.type === "propertyFields" ? PROPERTY_FIELD_KEYS : WIDGET_KEYS;
      const selected = draft.order.filter((item) => draft.enabled.has(item) && validKeys.includes(item));
      if (!selected.length) {
        showToast("1つ以上の表示項目を選んでください");
        return;
      }
      state.displayPreference[draft.type] = selected;
      const preferenceType = draft.type;
      const saved = persistState();
      closeModal();
      renderApp({ focusSelector: `[data-action="edit-preference"][data-preference="${preferenceType}"]` });
      showToast(saved ? "表示と順番を保存しました" : "表示を変更しましたが、端末へ保存できませんでした");
    }
    if (event.target.id === "reply-form") {
      if (runtime.replyPending) return;
      const formData = new FormData(event.target);
      const body = String(formData.get("reply") || "").trim();
      if (!body) {
        showToast("返信本文を入力してください");
        event.target.elements.reply?.focus();
        return;
      }
      if (containsInternalFragment(body, INTERNAL_REPLY_FRAGMENTS)) {
        showToast("鍵・AD・管理会社メモなどの社内限定情報を削除してください");
        event.target.elements.reply?.focus();
        return;
      }
      let approvedReply;
      runtime.replyPending = true;
      try {
        const draftId = "reply-c2-initial-v1";
        const approval = createMockReplyApproval({
          draftId,
          body,
          approvedBy: "employee:sato",
        });
        approvedReply = createApprovedReplyDTO({ customerId: "c2", draftId, body, approval });
        approvedReply = await replyGateway.sendApprovedReply(approvedReply);
      } catch (error) {
        runtime.replyPending = false;
        showToast(error.message || "返信内容を確認してください");
        return;
      }
      runtime.replyPending = false;
      runtime.sentReplies.set("c2", approvedReply);
      closeModal();
      runtime.completedTodayActions.add("ta2");
      renderApp({ focusSelector: '[data-action="open-reply"]' });
      showToast("確認済みの返信を送信しました（モック）");
    }
    if (event.target.id === "talk-form") {
      if (runtime.replyPending) return;
      const customerId = event.target.dataset.id;
      const customer = customerById(customerId);
      const body = String(new FormData(event.target).get("body") || "").trim();
      if (!customer) return;
      if (!body) {
        showToast("返信本文を入力してください");
        event.target.elements.body?.focus();
        return;
      }
      if (containsInternalFragment(body, INTERNAL_REPLY_FRAGMENTS)) {
        showToast("鍵・AD・管理会社メモなどの社内限定情報を削除してください");
        event.target.elements.body?.focus();
        return;
      }
      // 送信は「営業が確認した本文」と一致したときだけ通す（承認記録＋本文指紋）
      const messages = talkMessages(customerId);
      const draftId = `talk-${customerId}-${messages.length + 1}`;
      runtime.replyPending = true;
      try {
        const approval = createMockReplyApproval({ draftId, body, approvedBy: "employee:sato" });
        const dto = createApprovedReplyDTO({ customerId, draftId, body, approval });
        await replyGateway.sendApprovedReply(dto);
      } catch (error) {
        runtime.replyPending = false;
        showToast(error.message || "返信内容を確認してください");
        return;
      }
      runtime.replyPending = false;
      messages.push({ id: draftId, customerId, direction: "out", at: "たった今", body, status: "sent" });
      runtime.talkDraft = "";
      openTalk(customerId);
      showToast("確認済みの返信を送信しました（モック）");
    }
    if (event.target.id === "feedback-form") {
      const viewing = Viewing.find((item) => item.id === event.target.dataset.id);
      if (!viewing) return;
      const formData = new FormData(event.target);
      viewing.impression = String(formData.get("impression") || "").trim();
      viewing.temperature = String(formData.get("temperature") || "比較検討");
      viewing.nextAction = String(formData.get("next") || "追客予定を入れる");
      const mode = event.submitter?.dataset.submitMode || "save";
      if (mode === "apply") moveViewingToApplication(viewing.id);
      else {
        closeModal();
        renderApp({ focusSelector: `[data-action="open-feedback"][data-id="${viewing.id}"]` });
        showToast("内見の感想を保存しました");
      }
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && modalRoot.innerHTML) {
      event.preventDefault();
      closeModal();
      return;
    }
    if (event.key === "Escape" && runtime.deckMenuOpen) {
      event.preventDefault();
      runtime.deckMenuOpen = false;
      renderApp({ focusSelector: ".deck-fab" });
      return;
    }
    if (event.key !== "Tab" || !modalRoot.innerHTML) return;
    const focusable = [...modalRoot.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])')];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  renderApp();
})();
