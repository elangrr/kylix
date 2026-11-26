import { SiteHeader } from '../components/SiteHeader.tsx'
import { SiteFooter, REALM_URL } from '../components/SiteFooter.tsx'
import { MeanderBand } from '../components/Meander.tsx'
import { RingCard } from '../components/RingCard.tsx'
import { Link } from '../Link.tsx'
import { sampleRings } from '../sampleData.ts'
import { Stage } from '../story/Stage.tsx'
import { steps, type Step } from '../story/steps.ts'
import { useActiveStep } from '../story/hooks.ts'

function StepText({ step, index }: { step: Step; index: number }) {
  const first = index === 0
  return (
    <>
      <p className="step-label">
        <span className="step-number" aria-hidden="true">{index + 1}</span>
        {first ? 'Live on the Gno.land testnet' : step.label}
      </p>
      {first ? (
        <>
          <h1 className="hero-name" tabIndex={-1}>Kylix</h1>
          <p className="step-title step-title-lead">{step.title}</p>
        </>
      ) : (
        <h2 className="step-title">{step.title}</h2>
      )}
      {step.body.map((para) => (
        <p key={para} className={first && para.startsWith('A kylix') ? 'step-body step-aside' : 'step-body'}>
          {para}
        </p>
      ))}
    </>
  )
}

// The picture stays pinned while the steps scroll past it.
function ScrollStory() {
  const { active, refs } = useActiveStep(steps.length)
  const current = steps[active] ?? steps[0]
  return (
    <section className="story" aria-label="How Kylix works">
      <div className="story-stage">
        <div className="stage-frame">
          <Stage scene={active} label={current?.picture ?? ''} />
        </div>
        <ol className="stage-dots" aria-hidden="true">
          {steps.map((s, i) => (
            <li key={s.label} className={i === active ? 'is-active' : ''} />
          ))}
        </ol>
      </div>
      <div className="story-steps">
        {steps.map((step, i) => (
          <article
            key={step.label}
            className={`step ${i === active ? 'is-active' : ''} ${i === 0 ? 'step-first' : ''}`}
          >
            <div
              className="step-inner"
              ref={(el) => {
                refs.current[i] = el
              }}
            >
              <StepText step={step} index={i} />
              {i === 0 && <p className="scroll-hint" aria-hidden="true">Scroll to see a ring settle</p>}
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}

function LiveRings() {
  return (
    <section className="live" aria-labelledby="live-title">
      <MeanderBand className="meander-dark" />
      <div className="live-inner">
        <p className="step-label live-label">
          <span className="step-number" aria-hidden="true">7</span>
          Live rings
        </p>
        <h2 id="live-title" className="live-title">Rings ready to settle</h2>
        <p className="live-intro">
          These are samples that show how the list will look. The real list will come from the realm on the testnet.
        </p>
        <div className="ring-grid">
          {sampleRings.map((ring) => (
            <RingCard key={ring.id} ring={ring} />
          ))}
        </div>
        <div className="live-actions">
          <Link to="/app" className="button">Start trading</Link>
          <a className="text-link" href={REALM_URL}>Or trade now on the realm’s own page</a>
        </div>
      </div>
    </section>
  )
}

export function StoryPage() {
  return (
    <>
      <a className="skip-link" href="#live-title">Skip to the rings</a>
      <SiteHeader />
      <main>
        <ScrollStory />
        <LiveRings />
      </main>
      <SiteFooter />
    </>
  )
}
