import React, { useEffect, useMemo, useRef, useState } from "react";

import logoUrl from "./assets/logo.svg";

// 단일 파일 React 컴포넌트
// - .raw/.pcm 업로드
// - 여러 포맷 가정(코덱/엔디안/채널)으로 디코드
// - 샘플레이트는 고정 가정(assumedSR)으로 파형 썸네일 나열
// - 점수화 없음. 최소 필터(무음/심클리핑/스케일 이상)만 토글로 제거
// - 카드 클릭 시: 전체 길이 디코드 + 재생, 재생 SR 슬라이더(realSR)로 playbackRate 조절
// - (선택) WAV 다운로드: 선택 가정/설정으로 RIFF 헤더 씌워 16-bit PCM 저장

// 전역 타입 정의(컴포넌트 밖으로 이동하여 유틸 함수에서도 사용 가능)
type Fmt = "8u"|"16le"|"16be"|"24le"|"24be"|"32le"|"32f"|"mulaw"|"alaw"|"vox"|"g721";
type Cand = { id: string; fmt: Fmt; ch: 1|2; label: string; bytesPerSample: number };

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [arrayBuffer, setArrayBuffer] = useState<ArrayBuffer | null>(null);

  // 설정값들
  const [assumedSR, setAssumedSR] = useState<number>(16000); // 파형 x축 고정용
  const [previewSeconds, setPreviewSeconds] = useState<number>(5);
  const [enableSilentFilter, setEnableSilentFilter] = useState(true);
  const [enableClipFilter, setEnableClipFilter] = useState(true);
  const [enableScaleFilter, setEnableScaleFilter] = useState(true);
  const [limitCandidates, setLimitCandidates] = useState<number>(999); // 필요시 제한
  const ffmpegRef = useRef<any|null>(null);

  // 후보 포맷(최소 필수 세트)
  const candidates: Cand[] = useMemo(() => {
    const fmts: {fmt:Fmt, bps:number, name:string}[] = [
      {fmt:"16le", bps:2, name:"16LE"},
      {fmt:"16be", bps:2, name:"16BE"},
      {fmt:"8u",   bps:1, name:"8U"},
      {fmt:"24le", bps:3, name:"24LE"},
      {fmt:"24be", bps:3, name:"24BE"},
      {fmt:"32le", bps:4, name:"32LE"},
      {fmt:"32f",  bps:4, name:"32F"},
      {fmt:"mulaw",bps:1, name:"µ-law"},
      {fmt:"alaw", bps:1, name:"A-law"},
    ];
    const chs: (1|2)[] = [1,2];
    const list: Cand[] = [];
    for (const f of fmts) {
      for (const ch of chs) {
        list.push({
          id: `${f.fmt}-${ch}ch`,
          fmt: f.fmt,
          ch,
          label: `${f.name} • ${ch}ch`,
          bytesPerSample: f.bps,
        });
      }
    }
    // FFmpeg 필요 인코딩 후보(프리뷰 자동 디코드 제외, 버튼으로 디코드)
    // VOX(OKI ADPCM), G.721(G.726 32k) — 일반적으로 mono
    list.push({ id: `vox-1ch`, fmt: "vox", ch: 1, label: `VOX(OKI ADPCM) • 1ch`, bytesPerSample: 1 });
    list.push({ id: `g721-1ch`, fmt: "g721", ch: 1, label: `G.721 ADPCM • 1ch`, bytesPerSample: 1 });
    return list;
  }, []);

  // 업로드 처리
  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    // 확장자 제한(.pcm, .raw)
    const ok = /\.(pcm|raw|vox|g721|g726|adpcm)$/i.test(f.name);
    if (!ok) {
      alert(".pcm/.raw/.vox/.g721/.g726/.adpcm 파일만 업로드 가능합니다.");
      e.target.value = "";
      return;
    }
    setFile(f);
    const buf = await f.arrayBuffer();
    setArrayBuffer(buf);
  };

  // ---------- 디코드 유틸 ----------
  function decodePreview(buf: ArrayBuffer, cand: Cand, previewFrames: number) {
    // 반환: { chData: Float32Array[], hiddenReason?: string }
    try {
      // FFmpeg 필요 포맷은 프리뷰 자동 디코드 생략(버튼으로 수행)
      if (cand.fmt === "vox" || cand.fmt === "g721") {
        return { chData: [], hiddenReason: "FFmpeg 필요(버튼으로 디코드)" };
      }
      const chData = decodeRawToFloat32(buf, cand, previewFrames);
      const mono = downmixMono(chData);
      // 필터 적용(불리언 컷)
      let hiddenReason: string | undefined = undefined;
      if (enableSilentFilter && isSilentLike(mono)) hiddenReason = hiddenReason ?? "무음/평탄";
      if (enableClipFilter && isHeavilyClipped(mono)) hiddenReason = hiddenReason ?? "과도한 클리핑";
      if (enableScaleFilter && isScaleWeird(mono)) hiddenReason = hiddenReason ?? "스케일 이상";
      return { chData, hiddenReason };
    } catch (e) {
      return { chData: [], hiddenReason: "디코드 실패" };
    }
  }

  async function decodeFull(buf: ArrayBuffer, cand: Cand) {
    if (cand.fmt === "vox" || cand.fmt === "g721") {
      const out = await decodeWithFFmpeg(buf, cand, { sr: assumedSR, ref: ffmpegRef });
      return out;
    }
    return decodeRawToFloat32(buf, cand, undefined); // 전체 길이
  }

  function framesAvailable(buf: ArrayBuffer, cand: Cand) {
    const frameSize = cand.bytesPerSample * cand.ch;
    return Math.floor(buf.byteLength / frameSize);
  }

  function previewFramesFor(buf: ArrayBuffer, cand: Cand) {
    const maxFrames = framesAvailable(buf, cand);
    const want = Math.floor(assumedSR * previewSeconds);
    return Math.min(maxFrames, want);
  }

  // ---------- 결과 생성 ----------
  type CardItem = {
    cand: Cand;
    chData: Float32Array[]; // 프리뷰 구간만
    hiddenReason?: string;
  };

  const [cards, setCards] = useState<CardItem[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!arrayBuffer) { setCards([]); return; }
    let stopped = false;
    (async () => {
      setLoading(true);
      const out: CardItem[] = [];
      for (const cand of candidates.slice(0, limitCandidates)) {
        const pf = previewFramesFor(arrayBuffer, cand);
        if (pf <= 0) continue;
        const r = decodePreview(arrayBuffer, cand, pf);
        out.push({ cand, chData: r.chData, hiddenReason: r.hiddenReason });
        if (stopped) return;
        // 작은 yield로 UI 멈춤 방지
        await new Promise(res => setTimeout(res, 0));
      }
      if (!stopped) setCards(out);
      setLoading(false);
    })();
    return () => { stopped = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arrayBuffer, assumedSR, previewSeconds, enableSilentFilter, enableClipFilter, enableScaleFilter, limitCandidates]);

  // ---------- 재생/모달 ----------
  const [modal, setModal] = useState<null | {
    cand: Cand,
    realSR: number,
    fullCh?: Float32Array[],
    playing?: boolean,
  }>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  // FFmpeg 디코드 트리거 핸들러
  const onTryFFmpegDecode = useFFmpegButton({
    arrayBuffer,
    assumedSR,
    previewSeconds,
    setCards,
    ffmpegRef,
  });

  async function openModal(cand: Cand) {
    if (!arrayBuffer) return;
    // 전체 길이 디코드
    let fullCh: Float32Array[] | undefined = undefined;
    try {
      fullCh = await decodeFull(arrayBuffer, cand);
    } catch (e) {
      alert("전체 디코드 실패: " + errMsg(e));
      return;
    }
    setModal({ cand, realSR: assumedSR, fullCh, playing: false });
  }

  function stopAudio() {
    try { sourceRef.current?.stop(); } catch {}
    sourceRef.current = null;
  }

  function closeModal() {
    stopAudio();
    setModal(null);
  }

  async function playModal() {
    if (!modal?.fullCh) return;
    stopAudio();
    if (!audioCtxRef.current) audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    const ctx = audioCtxRef.current;
    const assumed = assumedSR; // 버퍼 생성 SR (가정)
    const buf = ctx.createBuffer(modal.cand.ch, modal.fullCh[0].length, assumed);
    for (let i=0; i<modal.cand.ch; i++) {
      // TS 5.x TypedArray generics 불일치 회피: copyToChannel 대신 set 사용
      const dest = buf.getChannelData(i);
      dest.set(modal.fullCh[i]);
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = modal.realSR / assumed; // SR 조절 → 재생속도 변경
    src.connect(ctx.destination);
    src.onended = () => setModal(m => m ? {...m, playing:false} : m);
    sourceRef.current = src;
    src.start();
    setModal(m => m ? {...m, playing:true} : m);
  }

  // WAV 저장(선택한 가정, 현재 realSR로 16-bit PCM 저장)
  function saveAsWav() {
    if (!modal?.fullCh) return;
    const pcm16 = floatTo16PCMInterleaved(modal.fullCh);
    const wav = makeWav(pcm16, modal.cand.ch, modal.realSR);
    const blob = new Blob([wav], {type:'audio/wav'});
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = `${file?.name || 'audio'}.${modal.cand.fmt}.${modal.cand.ch}ch.${modal.realSR}Hz.wav`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <header className="sticky top-0 z-10 backdrop-blur bg-neutral-950/70 border-b border-neutral-800">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3">
          <img src={logoUrl} alt="RAW PCM Explorer" className="w-6 h-6" />
          <div className="text-xl font-semibold">RAW PCM 파형 탐색기</div>
          <div className="ml-auto flex items-center gap-3">
            <input
              type="file"
              accept=".pcm,.raw,.vox,.g721,.g726,.adpcm"
              onChange={onFileChange}
              className="file:mr-4 file:rounded-lg file:border-0 file:bg-neutral-800 file:px-3 file:py-2 file:text-sm file:text-neutral-100 hover:file:bg-neutral-700"
            />
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6">
        <section className="mb-6 grid md:grid-cols-2 lg:grid-cols-4 gap-3">
          <Panel label="가정 샘플레이트 (파형용)">
            <NumberInput value={assumedSR} onChange={setAssumedSR} step={1} min={1000} />
            <div className="text-xs text-neutral-400 mt-1">파형은 이 SR 기준으로만 표시됩니다. 재생은 모달에서 별도 조절.</div>
          </Panel>
          <Panel label="프리뷰 길이(초)">
            <NumberInput value={previewSeconds} onChange={setPreviewSeconds} step={1} min={1} />
          </Panel>
          <Panel label="후보 제한(개)">
            <NumberInput value={limitCandidates} onChange={setLimitCandidates} step={1} min={1} />
          </Panel>
          <Panel label="필터">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enableSilentFilter} onChange={e=>setEnableSilentFilter(e.target.checked)} />무음/평탄 제거</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enableClipFilter} onChange={e=>setEnableClipFilter(e.target.checked)} />심한 클리핑 제거</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enableScaleFilter} onChange={e=>setEnableScaleFilter(e.target.checked)} />스케일 이상 제거</label>
          </Panel>
        </section>

        {file ? (
          <div className="mb-4 text-sm text-neutral-400 flex items-center gap-3 flex-wrap">
            <span>파일: <span className="text-neutral-200">{file.name}</span> • {bytesFmt(file.size)}</span>
            <button
              className="px-2 py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-xs"
              onClick={onTryFFmpegDecode}
              title="VOX, G.721 같은 인코딩된 RAW를 FFmpeg로 디코드하여 후보에 추가"
            >FFmpeg 디코드(VOX/G.721)</button>
          </div>
        ) : (
          <div className="mb-4 text-sm text-neutral-400">.pcm / .raw 파일을 업로드하세요</div>
        )}

        {loading && <div className="py-8 text-center text-neutral-400">분석 중…</div>}

        <div className="grid sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {cards.filter(c => !c.hiddenReason).map((c) => (
            <WaveCard key={c.cand.id}
              cand={c.cand}
              chData={c.chData}
              assumedSR={assumedSR}
              onOpen={() => openModal(c.cand)}
            />
          ))}
        </div>

        {/* 숨김된 후보도 필요시 보여주기 */}
        {cards.some(c => !!c.hiddenReason) && (
          <details className="mt-6">
            <summary className="cursor-pointer text-sm text-neutral-400 hover:text-neutral-300">숨김된 후보 보기</summary>
            <div className="grid sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 mt-3">
              {cards.filter(c => !!c.hiddenReason).map((c) => (
                <WaveCard key={c.cand.id}
                  cand={c.cand}
                  chData={c.chData}
                  assumedSR={assumedSR}
                  onOpen={() => openModal(c.cand)}
                  hiddenReason={c.hiddenReason}
                />
              ))}
            </div>
          </details>
        )}
      </main>

      {modal && (
        <div className="fixed inset-0 z-20 bg-black/70 flex items-center justify-center p-4" onClick={closeModal}>
          <div className="bg-neutral-900 rounded-2xl border border-neutral-800 w-full max-w-3xl p-4" onClick={e=>e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <div className="font-semibold">{modal.cand.label} • 재생 설정</div>
              <button className="text-neutral-400 hover:text-neutral-200" onClick={closeModal}>닫기</button>
            </div>
            <div className="grid md:grid-cols-3 gap-4">
              <div className="md:col-span-2">
                <LargeWave chData={modal.fullCh!} />
              </div>
              <div className="space-y-3">
                <div>
                  <div className="text-sm text-neutral-400">재생 샘플레이트 (realSR)</div>
                  <input type="number" className="mt-1 w-full bg-neutral-800 rounded px-2 py-1"
                         value={modal.realSR}
                         min={2000}
                         step={1}
                         onChange={e=>setModal(m=>m?{...m, realSR: Number(e.target.value)||assumedSR}:m)} />
                  <div className="text-xs text-neutral-500 mt-1">재생속도 = realSR / 가정SR({assumedSR})</div>
                </div>
                <div className="flex gap-2">
                  {!modal.playing ? (
                    <button className="px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500" onClick={playModal}>재생</button>
                  ) : (
                    <button className="px-3 py-2 rounded-lg bg-rose-600 hover:bg-rose-500" onClick={stopAudio}>정지</button>
                  )}
                  <button className="px-3 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700" onClick={saveAsWav}>WAV 저장</button>
                </div>
                <div className="text-xs text-neutral-500">재생은 원본 전체 길이를 사용합니다.</div>
              </div>
            </div>
          </div>
        </div>
      )}

      <footer className="py-6 text-center text-neutral-500 text-xs">© RAW PCM Explorer</footer>
    </div>
  );
}

// ====== UI 보조 컴포넌트 ======
function Panel({label, children}:{label:string, children:React.ReactNode}){
  return (
    <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-3">
      <div className="text-sm text-neutral-400 mb-2">{label}</div>
      {children}
    </div>
  );
}

function NumberInput({value,onChange,step=1,min}:{value:number,onChange:(v:number)=>void,step?:number,min?:number}){
  return (
    <input type="number" className="w-full bg-neutral-800 rounded px-2 py-1" value={value} step={step} min={min}
      onChange={e=>onChange(Number(e.target.value)||min||0)} />
  );
}

function WaveCard({cand, chData, assumedSR, onOpen, hiddenReason}:{
  cand: any; chData: Float32Array[]; assumedSR:number; onOpen:()=>void; hiddenReason?: string;
}){
  const mono = useMemo(()=>downmixMono(chData), [chData]);
  return (
    <div className="bg-neutral-900 border border-neutral-800 rounded-2xl overflow-hidden hover:border-neutral-700 transition-colors">
      <div className="px-3 pt-3 flex items-center justify-between">
        <div className="text-sm font-medium">{cand.label}</div>
        {hiddenReason && <span className="text-xs text-amber-400">{hiddenReason}</span>}
      </div>
      <div className="p-3">
        <WaveCanvas samples={mono} height={80} />
      </div>
      <div className="px-3 pb-3 flex items-center gap-2">
        <button className="px-3 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-sm" onClick={onOpen}>자세히/재생</button>
        <div className="text-xs text-neutral-500 ml-auto">가정SR {assumedSR} Hz</div>
      </div>
    </div>
  );
}

function LargeWave({chData}:{chData: Float32Array[]}){
  const mono = useMemo(()=>downmixMono(chData), [chData]);
  return (
    <div className="bg-neutral-950 border border-neutral-800 rounded-xl p-3">
      <WaveCanvas samples={mono} height={180} />
    </div>
  );
}

function WaveCanvas({samples, height=120}:{samples: Float32Array, height?: number}){
  const ref = useRef<HTMLCanvasElement|null>(null);
  useEffect(()=>{
    const canvas = ref.current; if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const widthCSS = canvas.clientWidth || 600;
    const heightCSS = height;
    canvas.width = Math.floor(widthCSS*dpr);
    canvas.height = Math.floor(heightCSS*dpr);
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    ctx.scale(dpr,dpr);
    drawWaveform(ctx, samples, widthCSS, heightCSS);
  }, [samples, height]);
  return <canvas ref={ref} className="w-full" style={{height}} />;
}

// ====== DSP/디코드 유틸 ======
function errMsg(e: any): string {
  if (!e) return "unknown";
  if (e instanceof Error) return e.message || "unknown";
  try { return typeof e === "string" ? e : JSON.stringify(e); } catch { return String(e); }
}
async function getFFmpeg(ref: React.MutableRefObject<any|null>) {
  if (ref.current) return ref.current;
  const { FFmpeg } = await import("@ffmpeg/ffmpeg");
  const { toBlobURL } = await import("@ffmpeg/util");
  const bases = [
    "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd",
    "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd",
    "https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm",
    "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm",
  ];
  const errs: string[] = [];
  for (const base of bases) {
    // 1) 시도: 워커 포함
    try {
      const ffTry = new FFmpeg();
      await ffTry.load({
        coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, "text/javascript"),
        wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, "application/wasm"),
        workerURL: await toBlobURL(`${base}/ffmpeg-core.worker.js`, "text/javascript"),
      });
      ref.current = ffTry; return ffTry;
    } catch (e1) {
      errs.push(`${base} (worker): ${errMsg(e1)}`);
      // 2) 폴백: 워커 없이
      try {
        const ffTry2 = new FFmpeg();
        await ffTry2.load({
          coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, "text/javascript"),
          wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, "application/wasm"),
        });
        ref.current = ffTry2; return ffTry2;
      } catch (e2) {
        errs.push(`${base} (no-worker): ${errMsg(e2)}`);
      }
    }
  }
  throw new Error("FFmpeg 로드 실패: " + errs.join(" | "));
}

async function decodeWithFFmpeg(buf: ArrayBuffer, cand: {fmt: Fmt, ch: 1|2}, opts?: {sr?: number, ref?: React.MutableRefObject<any|null>}){
  const sr = opts?.sr ?? 8000;
  const ref = opts?.ref!;
  const ff = await getFFmpeg(ref);
  // 로그 캡처(최근 메시지)
  const logs: string[] = [];
  const logHandler = (e: any) => { if (e?.message) logs.push(e.message); };
  try { (ff as any).on?.("log", logHandler); } catch {}
  const inName = cand.fmt === "vox" ? "in.vox" : "in.g726";
  const outName = "out.pcm";
  // 입력 파일 기록
  await ff.writeFile(inName, new Uint8Array(buf));
  // 시도할 명령 리스트
  const tries: string[][] = [];
  if (cand.fmt === "vox") {
    tries.push(["-ar", String(sr), "-ac", String(cand.ch), "-i", inName, "-f", "s16le", "-ac", String(cand.ch), "-ar", String(sr), outName]);
    tries.push(["-f", "vox", "-ar", String(sr), "-ac", String(cand.ch), "-i", inName, "-f", "s16le", "-ac", String(cand.ch), "-ar", String(sr), outName]);
    tries.push(["-f", "adpcm_ima_oki", "-ar", String(sr), "-ac", String(cand.ch), "-i", inName, "-f", "s16le", "-ac", String(cand.ch), "-ar", String(sr), outName]);
  } else {
    // g721 (g726 32kbps 가정) — 다양한 힌트 조합 시도
    tries.push(["-f", "g726", "-ar", String(sr), "-ac", String(cand.ch), "-i", inName, "-f", "s16le", "-ac", String(cand.ch), "-ar", String(sr), outName]);
    tries.push(["-f", "g726", "-bits_per_coded_sample", "4", "-ar", String(sr), "-ac", String(cand.ch), "-i", inName, "-f", "s16le", "-ac", String(cand.ch), "-ar", String(sr), outName]);
    tries.push(["-f", "g726", "-b:a", "32k", "-ar", String(sr), "-ac", String(cand.ch), "-i", inName, "-f", "s16le", "-ac", String(cand.ch), "-ar", String(sr), outName]);
    tries.push(["-f", "g726", "-bit_rate", "32000", "-ar", String(sr), "-ac", String(cand.ch), "-i", inName, "-f", "s16le", "-ac", String(cand.ch), "-ar", String(sr), outName]);
    tries.push(["-ar", String(sr), "-ac", String(cand.ch), "-i", inName, "-f", "s16le", "-ac", String(cand.ch), "-ar", String(sr), outName]);
  }
  let ok = false; let lastErr: any = null;
  for (const args of tries) {
    try {
      await ff.exec(args);
      ok = true; break;
    } catch (e) { lastErr = e; }
  }
  if (!ok) throw new Error("FFmpeg 디코드 실패: " + errMsg(lastErr) + (logs.length? "\n"+logs.slice(-20).join("\n"): ""));
  const raw = await ff.readFile(outName);
  const pcm = raw as Uint8Array;
  if (!pcm || pcm.byteLength === 0) {
    throw new Error("FFmpeg 디코드 결과가 비었습니다." + (logs.length? "\n"+logs.slice(-20).join("\n"): ""));
  }
  // s16le -> float32 (mono/ stereo interleaved X, cand.ch 별 배열 생성)
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const totalFrames = view.byteLength / 2 / cand.ch | 0;
  const out: Float32Array[] = new Array(cand.ch).fill(null).map(()=> new Float32Array(totalFrames));
  let p = 0;
  for (let i=0;i<totalFrames;i++){
    for (let ch=0; ch<cand.ch; ch++){
      const s = view.getInt16(p, true); p+=2;
      out[ch][i] = Math.max(-1, Math.min(1, s/32768));
    }
  }
  // 정리(필요시): await ff.deleteFile(inName); await ff.deleteFile(outName);
  return out;
}
function downmixMono(chs: Float32Array[]): Float32Array {
  if (!chs || chs.length===0) return new Float32Array();
  if (chs.length===1) return chs[0];
  const n = Math.min(chs[0].length, chs[1].length);
  const y = new Float32Array(n);
  for (let i=0;i<n;i++) y[i] = 0.5*(chs[0][i]+chs[1][i]);
  return y;
}

function drawWaveform(ctx: CanvasRenderingContext2D, x: Float32Array, width: number, height: number){
  ctx.clearRect(0,0,width,height);
  ctx.fillStyle = "#0a0a0a";
  ctx.fillRect(0,0,width,height);
  const step = Math.max(1, Math.floor(x.length / width));
  const mid = height/2;
  ctx.strokeStyle = "#cbd5e1"; // slate-300
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i=0;i<width;i++){
    const start = i*step, end = Math.min(x.length, start+step);
    let mn=Infinity, mx=-Infinity;
    for (let j=start;j<end;j++){ const v=x[j]; if (v<mn) mn=v; if (v>mx) mx=v; }
    if (mn===Infinity) continue;
    ctx.moveTo(i, mid - mx*mid);
    ctx.lineTo(i, mid - mn*mid);
  }
  ctx.stroke();
}

function isSilentLike(x: Float32Array){
  const n = x.length; if (!n) return true;
  let s=0, s2=0; for (let i=0;i<n;i++){ const v=x[i]; s+=v; s2+=v*v; }
  const mean = s/n; const v = s2/n - mean*mean; return v < 1e-6; // 매우 작은 분산
}

function isHeavilyClipped(x: Float32Array){
  const n = x.length; if (!n) return false;
  let c=0; for (let i=0;i<n;i++){ if (Math.abs(x[i])>0.99) c++; }
  return (c/n) > 0.25;
}

function isScaleWeird(x: Float32Array){
  const n = x.length; if (!n) return true;
  let s=0, s2=0; for (let i=0;i<n;i++){ const v=x[i]; s+=v; s2+=v*v; }
  const mean = s/n; const v = Math.max(0, s2/n - mean*mean); const std = Math.sqrt(v);
  return std < 1e-4 || std > 5; // 경험적 범위
}

function decodeRawToFloat32(buf: ArrayBuffer, cand: {fmt: Fmt, ch: 1|2, bytesPerSample: number}, previewFrames?: number): Float32Array[] {
  const dv = new DataView(buf);
  const bps = cand.bytesPerSample;
  const channels = cand.ch;
  const frameSize = bps * channels;
  let totalFrames = Math.floor(buf.byteLength / frameSize);
  if (previewFrames !== undefined) totalFrames = Math.min(totalFrames, previewFrames);
  if (totalFrames <= 0) return [new Float32Array()];

  // 출력 채널 메모리
  const out: Float32Array[] = new Array(channels).fill(null).map(()=> new Float32Array(totalFrames));

  // 픽셀 단위로 순회(프레임 단위)
  const fmt = cand.fmt;
  let offset = 0;

  if (fmt === "8u") {
    for (let i=0;i<totalFrames;i++){
      for (let ch=0; ch<channels; ch++){
        const u = dv.getUint8(offset);
        out[ch][i] = ((u - 128) / 128);
        offset += 1;
      }
    }
    return out;
  }

  if (fmt === "16le" || fmt === "16be") {
    const le = (fmt === "16le");
    for (let i=0;i<totalFrames;i++){
      for (let ch=0; ch<channels; ch++){
        const s = dv.getInt16(offset, le);
        out[ch][i] = Math.max(-1, Math.min(1, s / 32768));
        offset += 2;
      }
    }
    return out;
  }

  if (fmt === "24le" || fmt === "24be") {
    const le = (fmt === "24le");
    for (let i=0;i<totalFrames;i++){
      for (let ch=0; ch<channels; ch++){
        let b0 = dv.getUint8(offset);
        let b1 = dv.getUint8(offset+1);
        let b2 = dv.getUint8(offset+2);
        offset += 3;
        let val:number;
        if (le){
          val = (b0 | (b1<<8) | (b2<<16));
        } else {
          val = (b2 | (b1<<8) | (b0<<16));
        }
        // sign-extend 24bit
        if (val & 0x800000) val |= ~0xFFFFFF;
        out[ch][i] = Math.max(-1, Math.min(1, val / 8388608));
      }
    }
    return out;
  }

  if (fmt === "32le") {
    for (let i=0;i<totalFrames;i++){
      for (let ch=0; ch<channels; ch++){
        const s = dv.getInt32(offset, true);
        out[ch][i] = Math.max(-1, Math.min(1, s / 2147483648));
        offset += 4;
      }
    }
    return out;
  }

  if (fmt === "32f") {
    for (let i=0;i<totalFrames;i++){
      for (let ch=0; ch<channels; ch++){
        const f = dv.getFloat32(offset, true);
        // 이미 float32로 가정. 약간의 클램프만
        out[ch][i] = Math.max(-1, Math.min(1, f));
        offset += 4;
      }
    }
    return out;
  }

  if (fmt === "mulaw") {
    for (let i=0;i<totalFrames;i++){
      for (let ch=0; ch<channels; ch++){
        const u = dv.getUint8(offset);
        const s16 = muLawToLinear(u);
        out[ch][i] = s16 / 32768;
        offset += 1;
      }
    }
    return out;
  }

  if (fmt === "alaw") {
    for (let i=0;i<totalFrames;i++){
      for (let ch=0; ch<channels; ch++){
        const u = dv.getUint8(offset);
        const s16 = aLawToLinear(u);
        out[ch][i] = s16 / 32768;
        offset += 1;
      }
    }
    return out;
  }

  throw new Error("지원하지 않는 fmt");
}

// G.711 µ-law 디코드 (표준 역함수 구현)
function muLawToLinear(muByte: number): number {
  muByte = ~muByte & 0xFF;
  const sign = (muByte & 0x80) ? -1 : 1;
  let exponent = (muByte >> 4) & 0x07;
  let mantissa = muByte & 0x0F;
  let magnitude = ((mantissa << 3) + 0x84) << exponent;
  return sign * (magnitude - 0x84);
}

// G.711 A-law 디코드
function aLawToLinear(aVal: number): number {
  aVal ^= 0x55;
  let t = (aVal & 0x0F) << 4;
  const seg = (aVal & 0x70) >> 4;
  if (seg >= 1) t += 0x100;
  if (seg > 1) t <<= (seg -1);
  return (aVal & 0x80) ? t : -t;
}

function floatTo16PCMInterleaved(chs: Float32Array[]): Int16Array {
  const n = chs[0].length; const ch = chs.length;
  const out = new Int16Array(n*ch);
  for (let i=0;i<n;i++){
    for (let c=0;c<ch;c++){
      let v = Math.max(-1, Math.min(1, chs[c][i]));
      out[i*ch+c] = (v < 0 ? v * 32768 : v * 32767) | 0;
    }
  }
  return out;
}

function makeWav(pcm16Interleaved: Int16Array, channels: number, sampleRate: number): ArrayBuffer {
  const blockAlign = channels * 2;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm16Interleaved.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const dv = new DataView(buffer);
  let p = 0;
  // RIFF 헤더
  writeStr(dv, p, "RIFF"); p+=4;
  dv.setUint32(p, 36 + dataSize, true); p+=4;
  writeStr(dv, p, "WAVE"); p+=4;
  // fmt chunk
  writeStr(dv, p, "fmt "); p+=4;
  dv.setUint32(p, 16, true); p+=4;          // PCM fmt chunk size
  dv.setUint16(p, 1, true); p+=2;           // audio format = PCM(1)
  dv.setUint16(p, channels, true); p+=2;
  dv.setUint32(p, sampleRate, true); p+=4;
  dv.setUint32(p, byteRate, true); p+=4;
  dv.setUint16(p, blockAlign, true); p+=2;
  dv.setUint16(p, 16, true); p+=2;          // bits per sample
  // data chunk
  writeStr(dv, p, "data"); p+=4;
  dv.setUint32(p, dataSize, true); p+=4;
  // PCM 데이터
  for (let i=0;i<pcm16Interleaved.length; i++, p+=2) dv.setInt16(p, pcm16Interleaved[i], true);
  return buffer;
}

function writeStr(dv: DataView, offset: number, s: string){
  for (let i=0;i<s.length;i++) dv.setUint8(offset+i, s.charCodeAt(i));
}

function bytesFmt(n: number){
  if (n<1024) return `${n} B`;
  if (n<1024*1024) return `${(n/1024).toFixed(1)} KB`;
  if (n<1024*1024*1024) return `${(n/1024/1024).toFixed(1)} MB`;
  return `${(n/1024/1024/1024).toFixed(1)} GB`;
}

// ====== FFmpeg 트리거 훅 ======
// 파일 정보 영역의 버튼에서 호출되어 VOX/G.721을 시도, 성공 시 카드에 추가
function useFFmpegButton(
  params: {
    arrayBuffer: ArrayBuffer|null,
    assumedSR: number,
    previewSeconds: number,
    setCards: React.Dispatch<React.SetStateAction<{cand: Cand; chData: Float32Array[]; hiddenReason?: string}[]>>,
    ffmpegRef: React.MutableRefObject<any|null>
  }
){
  const { arrayBuffer, assumedSR, previewSeconds, setCards, ffmpegRef } = params;
  return async function onTryFFmpegDecode(){
    if (!arrayBuffer) return;
    const encCands: Cand[] = [
      { id: `vox-1ch`, fmt: "vox", ch: 1, label: `VOX(OKI ADPCM) • 1ch`, bytesPerSample: 1 },
      { id: `g721-1ch`, fmt: "g721", ch: 1, label: `G.721 ADPCM • 1ch`, bytesPerSample: 1 },
    ];
    const added: {cand: Cand; chData: Float32Array[]; hiddenReason?: string}[] = [];
    for (const cand of encCands){
      try {
        const full = await decodeWithFFmpeg(arrayBuffer, cand, { sr: assumedSR, ref: ffmpegRef });
        const want = Math.floor(assumedSR * previewSeconds);
        const chPrev = full.map(ch=> ch.length>want ? ch.slice(0,want) : ch);
        added.push({ cand, chData: chPrev });
      } catch {}
    }
    if (added.length){
      setCards(prev => {
        const ids = new Set(added.map(a=>a.cand.id));
        const rest = prev.filter(c => !ids.has(c.cand.id));
        return [...rest, ...added];
      });
    } else {
      alert("FFmpeg 디코드 실패(VOX/G.721). 샘플레이트/채널 가정값을 조정해보세요.");
    }
  }
}
