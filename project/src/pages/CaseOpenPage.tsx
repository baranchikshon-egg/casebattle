import { useState, useRef, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { useLiveDrops } from '@/lib/livedrops';
import type { Case, CaseItem, UserItem, LiveDrop } from '@/lib/types';
import { rollItem, generateReel, formatPrice } from '@/lib/utils';
import ItemCard from '@/components/ItemCard';
import { ArrowLeft, Zap, X, Dices } from 'lucide-react';

interface CaseOpenPageProps {
  caseData: Case;
  items: CaseItem[];
  onBack: () => void;
  onNavigate: (page: string) => void;
}

type ReelItem = CaseItem;
type SpinMode = 'normal' | 'ludo';

export default function CaseOpenPage({ caseData, items, onBack, onNavigate }: CaseOpenPageProps) {
  const { session, profile, refreshProfile } = useAuth();
  const { addDrop } = useLiveDrops();
  const [spinning, setSpinning] = useState(false);
  const [reel, setReel] = useState<ReelItem[]>([]);
  const [reelOffset, setReelOffset] = useState(0);
  const [result, setResult] = useState<CaseItem | null>(null);
  const [showResult, setShowResult] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fastMode, setFastMode] = useState(false);
  const [spinMode, setSpinMode] = useState<SpinMode>('normal');
  const reelRef = useRef<HTMLDivElement>(null);
  const animFrameRef = useRef<number | null>(null);
  const itemWidth = 140;

  const sortedItems = [...items].sort((a, b) => a.sort_order - b.sort_order);

  const cancelAnim = useCallback(() => {
    if (animFrameRef.current !== null) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
  }, []);

  useEffect(() => () => cancelAnim(), [cancelAnim]);

  function animateLudo(targetOffset: number, duration: number) {
    const numSegments = 30;
    const segmentDuration = duration / numSegments;

    // Random speed multipliers — chaotic, trending from fast to slow
    const speeds: number[] = [];
    for (let i = 0; i < numSegments; i++) {
      const progress = i / numSegments;
      const baseSpeed = 1 - progress * 0.75;
      // Occasionally near-stop for dramatic effect
      const noise = Math.random() < 0.12 ? 0.05 : 0.4 + Math.random() * 1.6;
      speeds.push(Math.max(0.01, baseSpeed * noise));
    }

    const totalSpeed = speeds.reduce((a, b) => a + b, 0);
    const keyframes: { time: number; offset: number }[] = [{ time: 0, offset: 0 }];
    let elapsed = 0;
    let offset = 0;
    for (let i = 0; i < numSegments; i++) {
      elapsed += segmentDuration;
      offset += (speeds[i] / totalSpeed) * targetOffset;
      keyframes.push({ time: elapsed, offset });
    }
    keyframes[keyframes.length - 1].offset = targetOffset;

    const startTime = performance.now();

    function frame(now: number) {
      const t = now - startTime;
      if (t >= duration) {
        setReelOffset(targetOffset);
        animFrameRef.current = null;
        return;
      }
      // Find current segment
      let idx = 0;
      for (let i = 0; i < keyframes.length - 1; i++) {
        if (t >= keyframes[i].time && t < keyframes[i + 1].time) {
          idx = i;
          break;
        }
      }
      const segT = (t - keyframes[idx].time) / segmentDuration;
      const currentOffset =
        keyframes[idx].offset + (keyframes[idx + 1].offset - keyframes[idx].offset) * segT;
      setReelOffset(currentOffset);
      animFrameRef.current = requestAnimationFrame(frame);
    }

    animFrameRef.current = requestAnimationFrame(frame);
  }

  async function handleOpen() {
    if (spinning) return;
    setError(null);
    cancelAnim();

    if (!session || !profile) {
      setError('Войдите, чтобы открыть кейс');
      return;
    }

    if (profile.balance < caseData.price) {
      setError('Недостаточно средств на балансе');
      return;
    }

    const newBalance = profile.balance - caseData.price;
    const { error: balanceError } = await supabase
      .from('profiles')
      .update({ balance: newBalance, cases_opened: profile.cases_opened + 1 })
      .eq('id', profile.id);

    if (balanceError) {
      setError('Ошибка списания средств');
      return;
    }

    const { error: txError } = await supabase.from('transactions').insert({
      user_id: profile.id,
      type: 'case_open',
      amount: -caseData.price,
      method: 'balance',
      description: `Открытие кейса "${caseData.name}"`,
    });

    if (txError) {
      // non-fatal
    }

    const winner = rollItem(items);

    const reelLength = 60;
    const newReel = generateReel(items, winner, reelLength);
    setReel(newReel);
    setResult(winner);
    setShowResult(false);
    setSpinning(true);

    const winnerIndex = reelLength - 5;
    const containerWidth = reelRef.current?.offsetWidth || 800;
    const centerOffset = containerWidth / 2 - itemWidth / 2;
    const targetOffset = -(winnerIndex * itemWidth) + centerOffset;
    setReelOffset(0);

    let duration: number;

    if (spinMode === 'ludo') {
      // Random duration between 5 and 9 seconds
      duration = 5000 + Math.random() * 4000;
      // Small delay to ensure reel renders at offset 0 first
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          animateLudo(targetOffset, duration);
        });
      });
    } else {
      duration = fastMode ? 2500 : 6000;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setReelOffset(targetOffset);
        });
      });
    }

    setTimeout(async () => {
      setSpinning(false);
      setShowResult(true);
      cancelAnim();

      const userItem: Omit<UserItem, 'id' | 'created_at'> = {
        user_id: profile.id,
        name: winner.name,
        weapon: winner.weapon,
        rarity: winner.rarity,
        wear: winner.wear,
        price: winner.price,
        image_url: winner.image_url,
        source: 'case',
        status: 'inventory',
      };
      await supabase.from('user_items').insert(userItem);

      const liveDrop: Omit<LiveDrop, 'id' | 'created_at'> = {
        user_id: profile.id,
        username: profile.username,
        avatar_url: profile.avatar_url,
        case_name: caseData.name,
        case_id: caseData.id,
        item_name: winner.name,
        item_image: winner.image_url,
        item_rarity: winner.rarity,
        item_price: winner.price,
        source: 'case',
      };
      const { data: dropData } = await supabase.from('live_drops').insert(liveDrop).select().maybeSingle();
      if (dropData) {
        addDrop(dropData as LiveDrop);
      }

      await refreshProfile();
    }, duration + 200); // small buffer for ludo
  }

  function closeResult() {
    setShowResult(false);
    setResult(null);
    setReel([]);
    setReelOffset(0);
  }

  return (
    <div className="min-h-[calc(100vh-200px)] py-6">
      <div className="max-w-7xl mx-auto px-4">
        {/* Back button */}
        <button
          onClick={onBack}
          className="flex items-center gap-2 text-gray-400 hover:text-css-orange transition-colors mb-6 font-body text-sm"
        >
          <ArrowLeft size={16} /> Назад к кейсам
        </button>

        {/* Case header */}
        <div className="text-center mb-8">
          <h1 className="font-display text-4xl md:text-5xl font-bold text-white uppercase tracking-wider">
            {caseData.name}
          </h1>
          <p className="text-gray-500 font-body mt-1">
            {sortedItems.length} предметов · Шанс на лучший: {(sortedItems[sortedItems.length - 1]?.chance * 100).toFixed(2)}%
          </p>
        </div>

        {/* Spin mode selector */}
        <div className="flex justify-center gap-2 mb-6">
          <button
            onClick={() => !spinning && setSpinMode('normal')}
            disabled={spinning}
            className={`flex items-center gap-2 px-5 py-2.5 font-display text-sm uppercase tracking-wider border transition-colors disabled:opacity-40 ${
              spinMode === 'normal'
                ? 'border-css-orange text-css-orange bg-css-orange/10'
                : 'border-css-border text-gray-400 hover:text-white hover:border-gray-600'
            }`}
          >
            <Zap size={16} /> Обычная
          </button>
          <button
            onClick={() => !spinning && setSpinMode('ludo')}
            disabled={spinning}
            className={`flex items-center gap-2 px-5 py-2.5 font-display text-sm uppercase tracking-wider border transition-colors disabled:opacity-40 ${
              spinMode === 'ludo'
                ? 'border-css-orange text-css-orange bg-css-orange/10'
                : 'border-css-border text-gray-400 hover:text-white hover:border-gray-600'
            }`}
          >
            <Dices size={16} /> Лудо
          </button>
        </div>

        {/* Reel area */}
        <div className="relative bg-css-darker border-2 border-css-border overflow-hidden h-[200px] mb-6">
          {/* Center marker */}
          <div className="absolute top-0 bottom-0 left-1/2 -translate-x-1/2 w-0.5 bg-css-orange z-20 pointer-events-none" />
          <div className="absolute top-0 left-1/2 -translate-x-1/2 z-20 pointer-events-none">
            <div className="w-0 h-0 border-l-[8px] border-l-transparent border-r-[8px] border-r-transparent border-t-[8px] border-t-css-orange" />
          </div>
          <div className="absolute bottom-0 left-1/2 -translate-x-1/2 z-20 pointer-events-none">
            <div className="w-0 h-0 border-l-[8px] border-l-transparent border-r-[8px] border-r-transparent border-b-[8px] border-b-css-orange" />
          </div>

          {/* Gradient edges */}
          <div className="absolute left-0 top-0 bottom-0 w-32 bg-gradient-to-r from-css-darker to-transparent z-10 pointer-events-none" />
          <div className="absolute right-0 top-0 bottom-0 w-32 bg-gradient-to-l from-css-darker to-transparent z-10 pointer-events-none" />

          {/* Reel */}
          <div ref={reelRef} className="h-full overflow-hidden">
            {reel.length > 0 ? (
              <div
                className="flex gap-2 h-full items-center px-2"
                style={{
                  transform: `translateX(${reelOffset}px)`,
                  transition: spinMode === 'normal' && spinning
                    ? `transform ${fastMode ? '2.5s' : '6s'} cubic-bezier(0.12, 0.8, 0.18, 1)`
                    : 'none',
                }}
              >
                {reel.map((item, i) => (
                  <div key={i} className="flex-shrink-0" style={{ width: `${itemWidth - 8}px` }}>
                    <ItemCard
                      name={item.name}
                      weapon={item.weapon}
                      rarity={item.rarity}
                      wear={item.wear}
                      price={item.price}
                      size="sm"
                    />
                  </div>
                ))}
              </div>
            ) : (
              <div className="h-full flex items-center justify-center">
                <div className="text-center">
                  <div className="text-6xl font-display font-bold text-css-orange/20 mb-2">{caseData.name.slice(0, 2).toUpperCase()}</div>
                  <p className="text-gray-600 font-body text-sm uppercase tracking-widest">Нажмите открыть</p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Controls */}
        <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-8">
          <button
            onClick={handleOpen}
            disabled={spinning}
            className="flex items-center gap-2 bg-css-orange hover:bg-css-orange-light disabled:opacity-40 text-black font-display font-bold uppercase tracking-wider px-8 py-3 transition-colors text-lg"
          >
            {spinning ? 'Открытие...' : `Открыть за ${formatPrice(caseData.price)}`}
          </button>

          {spinMode === 'normal' && (
            <button
              onClick={() => setFastMode(!fastMode)}
              disabled={spinning}
              className={`flex items-center gap-2 border px-4 py-3 font-display text-sm uppercase tracking-wider transition-colors disabled:opacity-40 ${
                fastMode ? 'border-css-orange text-css-orange bg-css-orange/10' : 'border-css-border text-gray-400 hover:text-white'
              }`}
            >
              <Zap size={16} /> Быстро
            </button>
          )}
        </div>

        {/* Ludo description */}
        {spinMode === 'ludo' && (
          <p className="text-center text-gray-600 font-body text-xs mb-6">
            Хаотичная прокрутка со случайной скоростью и длительностью (до 9 секунд)
          </p>
        )}

        {error && (
          <div className="max-w-md mx-auto bg-css-red/20 border border-css-red text-css-red px-4 py-2 text-center font-body text-sm mb-6 animate-shake">
            {error}
          </div>
        )}

        {/* Contents grid */}
        <div className="border-t border-css-border pt-6">
          <h2 className="font-display text-xl uppercase tracking-wider text-white mb-4">Содержимое кейса</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
            {sortedItems.map((item) => (
              <ItemCard
                key={item.id}
                name={item.name}
                weapon={item.weapon}
                rarity={item.rarity}
                wear={item.wear}
                price={item.price}
                chance={item.chance}
                size="md"
              />
            ))}
          </div>
        </div>
      </div>

      {/* Result modal */}
      {showResult && result && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-md animate-fade-in" onClick={closeResult}>
          <div className="relative animate-scale-in" onClick={(e) => e.stopPropagation()}>
            <button onClick={closeResult} className="absolute -top-10 right-0 text-gray-500 hover:text-white">
              <X size={24} />
            </button>
            <div className="text-center mb-4">
              <p className="font-display text-2xl uppercase tracking-widest text-css-orange">Поздравляем!</p>
              <p className="text-gray-400 font-body text-sm">Вам выпал:</p>
            </div>
            <div className={`glow-${result.rarity}`}>
              <ItemCard
                name={result.name}
                weapon={result.weapon}
                rarity={result.rarity}
                wear={result.wear}
                price={result.price}
                size="lg"
              />
            </div>
            <div className="flex gap-3 mt-6 justify-center">
              <button
                onClick={closeResult}
                className="px-6 py-2.5 bg-css-panel border border-css-border hover:border-css-orange text-white font-display uppercase tracking-wider text-sm transition-colors"
              >
                Забрать
              </button>
              <button
                onClick={() => { closeResult(); onNavigate('upgrade'); }}
                className="px-6 py-2.5 bg-css-orange hover:bg-css-orange-light text-black font-display uppercase tracking-wider text-sm transition-colors"
              >
                Апгрейд
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
