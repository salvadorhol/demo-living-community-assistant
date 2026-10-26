import {useEffect, useRef, useState} from 'react';
import {useSearchParams} from 'react-router-dom';
import styles from './presentation-page.module.scss';

const chapters = [
  'Introduction',
  'System overview',
  'Facts through tools',
  'Post-call review',
  'Run locally',
  'Progress',
];
const timings = [
  '0:00–0:40',
  '0:40–1:40',
  '1:40–3:20',
  '3:20–4:20',
  '4:20–5:20',
  '5:20–6:30',
];

function GraphNode({
  x,
  y,
  width,
  title,
  detail,
}: {
  x: number;
  y: number;
  width: number;
  title: string;
  detail: string;
}) {
  return (
    <g className={styles.graphNode}>
      <rect x={x} y={y} width={width} height={76} rx="3" />
      <text x={x + 18} y={y + 30} className={styles.graphHeading}>
        {title}
      </text>
      <text x={x + 18} y={y + 56} className={styles.graphDetail}>
        {detail}
      </text>
    </g>
  );
}

function ArrowDefinition({id}: {id: string}) {
  return (
    <defs>
      <marker
        id={id}
        viewBox="0 0 10 10"
        refX="9"
        refY="5"
        markerWidth="6"
        markerHeight="6"
        orient="auto-start-reverse"
      >
        <path d="M 0 0 L 10 5 L 0 10 z" fill="#315dc6" />
      </marker>
    </defs>
  );
}

function OverviewGraph() {
  return (
    <div className={styles.graphViewport}>
      <svg
        className={styles.overviewGraph}
        viewBox="0 0 1120 400"
        role="img"
        aria-labelledby="overview-title overview-description"
      >
        <title id="overview-title">
          How a conversation moves through Sophie
        </title>
        <desc id="overview-description">
          The caller speaks through React to the Socket.IO conversation server.
          The server connects to OpenAI voice, asynchronous decision checks, and
          Firebase tools. It saves transcripts and audio for a separate
          post-call review and human-reviewed improvements.
        </desc>
        <ArrowDefinition id="overview-arrow" />
        <g
          className={styles.graphEdges}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path
            d="M 120 143 H 160"
            markerStart="url(#overview-arrow)"
            markerEnd="url(#overview-arrow)"
          />
          <path
            d="M 330 143 H 390"
            markerStart="url(#overview-arrow)"
            markerEnd="url(#overview-arrow)"
          />
          <path
            d="M 600 130 H 645 V 43 H 690"
            markerStart="url(#overview-arrow)"
            markerEnd="url(#overview-arrow)"
          />
          <path
            d="M 600 143 H 690"
            markerStart="url(#overview-arrow)"
            markerEnd="url(#overview-arrow)"
          />
          <path
            d="M 600 156 H 645 V 243 H 690"
            markerStart="url(#overview-arrow)"
            markerEnd="url(#overview-arrow)"
          />
          <path d="M 495 181 V 315" markerEnd="url(#overview-arrow)" />
          <path d="M 600 353 H 690" markerEnd="url(#overview-arrow)" />
        </g>
        <GraphNode x={1} y={105} width={119} title="Caller" detail="Speech" />
        <GraphNode
          x={160}
          y={105}
          width={170}
          title="React"
          detail="Voice + transcript"
        />
        <GraphNode
          x={390}
          y={105}
          width={210}
          title="Voice server"
          detail="Node.js + Socket.IO"
        />
        <GraphNode
          x={690}
          y={5}
          width={429}
          title="OpenAI voice + transcription"
          detail="gpt-realtime-2.1-mini · gpt-live-transcribe"
        />
        <GraphNode
          x={690}
          y={105}
          width={429}
          title="Decision checks"
          detail="gpt-6-luna · injection, frustration, language"
        />
        <GraphNode
          x={690}
          y={205}
          width={429}
          title="Community + action tools"
          detail="Firebase Auth, Functions and Firestore"
        />
        <GraphNode
          x={390}
          y={315}
          width={210}
          title="Saved calls"
          detail="Transcript + audio"
        />
        <GraphNode
          x={690}
          y={315}
          width={429}
          title="Post-call review → human improvement"
          detail="gpt-6-luna · transcript evidence"
        />
        <text x={510} y={260} className={styles.edgeLabel}>
          Firestore + Storage
        </text>
      </svg>
    </div>
  );
}

function ProcessGraph() {
  const steps = [
    ['Saved transcript', 'Text supplied to reviewer'],
    ['Advisory review', 'Observations + suggestions'],
    ['Cited evidence', 'Trace to exact utterances'],
    ['Human review', 'Choose instruction changes'],
  ];
  const id = 'review-arrow';
  return (
    <div className={styles.graphViewport}>
      <svg
        className={styles.processGraph}
        viewBox="0 0 1120 110"
        role="img"
        aria-label="Saved transcript, advisory review, cited evidence, then human-reviewed improvements"
      >
        <ArrowDefinition id={id} />
        {steps.map(([title, detail], index) => (
          <g key={title}>
            {index < steps.length - 1 && (
              <path
                className={styles.graphEdges}
                d={`M ${index * 285 + 250} 50 H ${index * 285 + 283}`}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                markerEnd={`url(#${id})`}
              />
            )}
            <GraphNode
              x={index * 285 + 1}
              y={12}
              width={249}
              title={title}
              detail={detail}
            />
          </g>
        ))}
      </svg>
    </div>
  );
}

function Tradeoff({benefit, cost}: {benefit: string; cost: string}) {
  return (
    <div className={styles.tradeoff}>
      <section>
        <p className={styles.label}>Why I chose it</p>
        <p>{benefit}</p>
      </section>
      <section>
        <p className={styles.label}>What it costs</p>
        <p>{cost}</p>
      </section>
    </div>
  );
}

function Slide({index}: {index: number}) {
  switch (index) {
    case 0:
      return (
        <div className={styles.cover}>
          <p className={styles.eyebrow}>Further / AI Engineer Assignment</p>
          <h1 id="slide-title">
            Sophie: a trustworthy
            <br />
            <em>sales conversation.</em>
          </h1>
          <p className={styles.lead}>
            Grounded answers. Confirmed actions.
            <br />
            Conversations we can inspect.
          </p>
          <div className={styles.coverBottom}>
            <span>Approach, decisions and implementation progress</span>
            <span>6½-minute walkthrough</span>
          </div>
        </div>
      );
    case 1:
      return (
        <>
          <p className={styles.eyebrow}>02 / System overview</p>
          <h1 id="slide-title">How a conversation moves through the system</h1>
          <OverviewGraph />
          <p className={styles.annotation}>
            Clear responsibilities make failures easier to investigate. Decision
            checks are asynchronous; they do not block every response or tool
            action.
          </p>
        </>
      );
    case 2:
      return (
        <>
          <p className={styles.eyebrow}>03 / Key decision</p>
          <h1 id="slide-title">
            Community facts
            <br />
            <em>through tools</em>
          </h1>
          <div className={styles.comparison}>
            <section>
              <p className={styles.label}>Alternative / one large prompt</p>
              <h2>Instructions + community facts</h2>
              <p>Simpler request path. Facts and behavior change together.</p>
            </section>
            <section>
              <p className={styles.label}>Chosen / focused lookups</p>
              <h2>Behavioral prompt + fact tools</h2>
              <p>Explicit data boundaries. Independently testable lookups.</p>
            </section>
          </div>
          <Tradeoff
            benefit="Clearer sources and unknowns; reuse relevant results during the call."
            cost="Extra requests, latency, potential API cost and lookup failures."
          />
          <div className={styles.factExample}>
            <p className={styles.label}>Source facts / intended behavior</p>
            <p>
              <strong>Assisted Living: from $3,000/month.</strong> Two-bedroom
              pricing: unknown. Acknowledge the gap and offer follow-up.
            </p>
          </div>
        </>
      );
    case 3:
      return (
        <>
          <p className={styles.eyebrow}>04 / Key decision</p>
          <h1 id="slide-title">
            Review
            <br />
            <em>after the call</em>
          </h1>
          <ProcessGraph />
          <Tradeoff
            benefit="Evidence-linked feedback without adding the full assessment to live response time."
            cost="Issues surface afterward. Transcript-only review cannot establish factual accuracy."
          />
          <p className={styles.annotation}>
            Humans can inspect saved audio. The AI reviewer receives no audio,
            authoritative community facts or tool execution history. Suggestions
            do not automatically update instructions.
          </p>
        </>
      );
    case 4:
      return (
        <>
          <p className={styles.eyebrow}>05 / Reproducibility</p>
          <h1 id="slide-title">Run the demo locally.</h1>
          <div className={styles.runLayout}>
            <section>
              <p className={styles.label}>
                Repository root / Node 24.22.1 + Java 21+
              </p>
              <pre>
                <code>
                  {
                    'nvm use\nnpm ci\ncp apps/socket-server/.env.example \\\n  apps/socket-server/.env\nnpm run dev'
                  }
                </code>
              </pre>
              <p className={styles.small}>
                Firebase emulators run locally. No cloud project required.
              </p>
            </section>
            <section>
              <p className={styles.label}>Before launching</p>
              <h2>Configure server secrets</h2>
              <p>
                <code>apps/socket-server/.env</code>
                <br />
                <code>OPENAI_API_KEY</code> for live voice.
              </p>
              <p>
                <code>functions/.secret.local</code>
                <br />
                <code>APP_ACCESS_PASSWORD</code> and{' '}
                <code>ADMIN_ACCESS_PASSWORD</code>. Add{' '}
                <code>OPENAI_API_KEY</code> for AI call reviews.
              </p>
              <p className={styles.small}>
                Both files stay gitignored. Keep credentials out of browser
                configuration.
              </p>
            </section>
          </div>
          <div className={styles.addresses}>
            <span>localhost:4200</span>
            <span>/presentation</span>
            <span>/admin</span>
            <span>/admin/review</span>
          </div>
        </>
      );
    default:
      return (
        <>
          <p className={styles.eyebrow}>06 / Implementation progress</p>
          <h1 id="slide-title">
            Progress, boundaries,
            <br />
            <em>and next steps</em>
          </h1>
          <div className={styles.progressColumns}>
            <section>
              <p className={styles.label}>Implemented</p>
              <ul>
                <li>Voice conversations + live transcripts</li>
                <li>Community tools + confirmed requests</li>
                <li>Admin configuration + saved-call review</li>
                <li>Automated tests with a fake voice provider</li>
              </ul>
            </section>
            <section>
              <p className={styles.label}>Next investments</p>
              <h2>Evaluate factual answers</h2>
              <p>Compare answers with community data and tool results.</p>
              <h2>Measure the tradeoffs</h2>
              <p>Benchmark lookup latency and guardrail accuracy.</p>
            </section>
          </div>
          <p className={styles.annotation}>
            Assignment-supplied facts and configured availability. No real
            bookings, outbound callbacks or live transfers. Fake-provider tests
            do not establish live-model reliability.
          </p>
        </>
      );
  }
}

export function PresentationPage() {
  const [params, setParams] = useSearchParams();
  const parsed = Number(params.get('slide') ?? 1);
  const index = Number.isInteger(parsed)
    ? Math.max(0, Math.min(chapters.length - 1, parsed - 1))
    : 0;
  const root = useRef<HTMLDivElement>(null);
  const [fullscreenError, setFullscreenError] = useState('');
  function navigate(next: number) {
    const updated = new URLSearchParams(params);
    updated.set(
      'slide',
      String(Math.max(0, Math.min(chapters.length - 1, next)) + 1)
    );
    setParams(updated, {replace: true});
  }
  useEffect(() => {
    const previous = document.title;
    document.title = `${chapters[index]} · Sophie presentation`;
    return () => {
      document.title = previous;
    };
  }, [index]);
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        (event.target instanceof HTMLElement &&
          event.target.closest(
            'input, textarea, select, [contenteditable="true"]'
          ))
      )
        return;
      const next =
        event.key === 'ArrowRight' || event.key === 'PageDown'
          ? index + 1
          : event.key === 'ArrowLeft' || event.key === 'PageUp'
            ? index - 1
            : event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? chapters.length - 1
                : undefined;
      if (next !== undefined) {
        event.preventDefault();
        navigate(next);
      }
    }
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  });
  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await root.current?.requestFullscreen();
      setFullscreenError('');
    } catch {
      setFullscreenError(
        'Fullscreen is unavailable. Use your browser’s fullscreen option.'
      );
    }
  }
  return (
    <div ref={root} className={styles.presentation}>
      <header className={styles.header}>
        <a href="/presentation" aria-label="Sophie presentation home">
          sophie<span>.</span>
        </a>
        <span>Engineering walkthrough</span>
        <button onClick={() => void toggleFullscreen()}>Fullscreen</button>
      </header>
      <main className={styles.slide} aria-labelledby="slide-title" key={index}>
        <Slide index={index} />
      </main>
      <footer className={styles.footer}>
        <div className={styles.chapter}>
          <span>
            {String(index + 1).padStart(2, '0')} /{' '}
            {String(chapters.length).padStart(2, '0')}
          </span>
          <span aria-live="polite">{chapters[index]}</span>
        </div>
        <div className={styles.recordingTime}>
          Loom cue <span>{timings[index]}</span>
        </div>
        <nav aria-label="Slide navigation">
          <button
            aria-label="Previous slide"
            disabled={index === 0}
            onClick={() => navigate(index - 1)}
          >
            ←
          </button>
          <span className={styles.keyHint}>Use arrow keys</span>
          <button
            aria-label="Next slide"
            disabled={index === chapters.length - 1}
            onClick={() => navigate(index + 1)}
          >
            →
          </button>
        </nav>
      </footer>
      <div
        className={styles.progress}
        style={{width: `${((index + 1) / chapters.length) * 100}%`}}
      />
      {fullscreenError && (
        <p className={styles.fullscreenError} role="status">
          {fullscreenError}
        </p>
      )}
    </div>
  );
}
export default PresentationPage;
