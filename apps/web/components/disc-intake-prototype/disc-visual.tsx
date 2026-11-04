"use client";

import { useId } from "react";
import type { CSSProperties } from "react";
import { stateLabels, type PrototypeDrive } from "./model";
import styles from "./disc-visual.module.css";

const colors = { complete: "#7ad8a0", active: "#e9bf63", error: "#f08d81", idle: "#7a8c88", cancelled: "#97a6a0" };

export function StatusDot({ state }: { state: PrototypeDrive["state"] }) {
  return <span className={styles.dot} style={{ background: colors[state] }} role="img" aria-label={stateLabels[state]} />;
}

export function DiscVisual({ drive, size = 420, className = "", compact = false }: { drive: PrototypeDrive; size?: number; className?: string; compact?: boolean }) {
  const id = useId().replaceAll(":", "");
  const progress = Math.max(0, Math.min(100, drive.progress ?? 0));
  const unknown = drive.state === "active" && drive.progress === null;
  const title = drive.title ?? (drive.state === "idle" ? "Insert a disc" : "Unidentified disc");
  return (
    <div className={`${styles.visual} ${className}`} style={{ "--disc-size": `${size}px` } as CSSProperties}>
      <svg viewBox="0 0 500 500" className={styles.svg} role="img" aria-label={`${title}. ${drive.phase}. ${drive.progress === null ? "Progress unavailable" : `${progress}% archived`}`}>
        <defs>
          <radialGradient id={`${id}-silver`}><stop stopColor="#d8e6dc" /><stop offset=".36" stopColor="#758e89" /><stop offset=".58" stopColor="#c6b8a1" /><stop offset=".77" stopColor="#708b89" /><stop offset="1" stopColor="#d1d8cf" /></radialGradient>
          <linearGradient id={`${id}-orbit`} x2="0.2" y2="1"><stop stopColor="#081c2b" /><stop offset=".5" stopColor="#173849" /><stop offset="1" stopColor="#b26c3f" /></linearGradient>
          <linearGradient id={`${id}-planet`} x2=".4" y2="1"><stop stopColor="#ffe5af" /><stop offset=".48" stopColor="#cf8c56" /><stop offset="1" stopColor="#633a32" /></linearGradient>
          <linearGradient id={`${id}-tide`} x2=".2" y2="1"><stop stopColor="#d2c6a5" /><stop offset=".5" stopColor="#788f87" /><stop offset="1" stopColor="#153a40" /></linearGradient>
          <linearGradient id={`${id}-grove`} x2="0" y2="1"><stop stopColor="#bcb891" /><stop offset=".4" stopColor="#607c64" /><stop offset="1" stopColor="#102e29" /></linearGradient>
          <linearGradient id={`${id}-sheen`} x2="1" y2=".8"><stop stopColor="#fff" stopOpacity=".13" /><stop offset=".35" stopColor="#fff" stopOpacity="0" /><stop offset=".62" stopColor="#fff" stopOpacity=".06" /><stop offset="1" stopColor="#fff" stopOpacity="0" /></linearGradient>
          <mask id={`${id}-disc`}><circle cx="250" cy="250" r="211" fill="white" /><circle cx="250" cy="250" r="26" fill="black" /></mask>
        </defs>
        <circle cx="250" cy="250" r="229" fill="none" stroke="#90b0a2" strokeOpacity=".14" strokeWidth="5" />
        <g className={unknown ? styles.indeterminate : undefined}>
          <circle cx="250" cy="250" r="229" fill="none" stroke={colors[drive.state]} strokeWidth="5" strokeLinecap="round" pathLength="100" strokeDasharray={`${unknown ? 19 : progress} 100`} transform="rotate(-90 250 250)" className={styles.progress} />
        </g>
        <g mask={`url(#${id}-disc)`}>
          <circle cx="250" cy="250" r="211" fill={`url(#${id}-silver)`} />
          {drive.artwork === "orbit" && <>
            <circle cx="250" cy="250" r="208" fill={`url(#${id}-orbit)`} />
            {[ [110,120], [301,82], [363,192], [167,210], [330,240], [400,280], [100,273], [230,64], [379,127], [143,176] ].map(([x,y],i) => <circle key={i} cx={x} cy={y} r={i % 3 === 0 ? 1.8 : 1} fill="#f8e2bc" opacity=".6" />)}
            <circle cx="327" cy="316" r="98" fill={`url(#${id}-planet)`} />
            <ellipse cx="302" cy="320" rx="151" ry="24" transform="rotate(-23 302 320)" fill="none" stroke="#e9bd8a" strokeOpacity=".5" strokeWidth="2" />
            <path d="M25 380 Q160 330 260 385 T485 355 L500 500 H0Z" fill="#0a1920" />
            <path d="M8 410 Q135 360 240 415 T490 390" fill="none" stroke="#c18557" strokeOpacity=".4" />
            <text x="250" y="122" textAnchor="middle" fill="#ecddbf" fontFamily="sans-serif" fontSize="10" letterSpacing="6">A JOURNEY BEYOND HOME</text>
            <text x="250" y="160" textAnchor="middle" fill="#f3e6c9" fontFamily="Georgia,serif" fontSize="22" letterSpacing="6">THE LAST</text>
            <text x="250" y="205" textAnchor="middle" fill="#f3e6c9" fontFamily="Georgia,serif" fontSize="49" letterSpacing="10">ORBIT</text>
          </>}
          {drive.artwork === "tide" && <>
            <circle cx="250" cy="250" r="208" fill={`url(#${id}-tide)`} />
            <circle cx="315" cy="189" r="52" fill="#e5d4ad" opacity=".76" />
            <path d="M0 240 Q100 219 200 249 T500 232 V500 H0Z" fill="#476d70" />
            {[278,307,340,380,427].map((y,i) => <path key={y} d={`M15 ${y} Q130 ${y-24} 250 ${y+5} T490 ${y-8}`} fill="none" stroke={i % 2 ? "#94b1a5" : "#244f57"} strokeWidth={i+2} opacity=".7" />)}
            <path d="M74 403 Q130 326 154 270 L171 287 L159 394Z" fill="#233c35" />
            <text x="250" y="139" textAnchor="middle" fill="#203b38" fontFamily="Georgia,serif" fontSize="26" fontStyle="italic">a quiet</text>
            <text x="250" y="195" textAnchor="middle" fill="#203b38" fontFamily="Georgia,serif" fontSize="63" letterSpacing="8">TIDE</text>
          </>}
          {drive.artwork === "grove" && <>
            <circle cx="250" cy="250" r="208" fill={`url(#${id}-grove)`} />
            <circle cx="320" cy="170" r="61" fill="#d8c89c" opacity=".65" />
            <path d="M0 325 Q100 175 245 303 T500 269 V500 H0Z" fill="#476e55" />
            <path d="M0 398 Q155 285 270 368 T500 330 V500 H0Z" fill="#1e4c40" />
            {[80,118,367,405].map((x,i)=><path key={x} d={`M${x} 420 V${220+i*16} m-22 33 22-33 25 40 m-53 13 28-32 33 37`} stroke="#17372f" strokeWidth="7" fill="none" />)}
            <text x="250" y="142" textAnchor="middle" fill="#f2e9cc" fontFamily="Georgia,serif" fontSize="20" letterSpacing="6">THE HIDDEN</text>
            <text x="250" y="196" textAnchor="middle" fill="#f2e9cc" fontFamily="Georgia,serif" fontSize="46" letterSpacing="5">GROVE</text>
          </>}
          {drive.artwork === null && <>
            <circle cx="250" cy="250" r="190" fill="none" stroke="#14332d" strokeOpacity=".23" />
            <text x="250" y="157" textAnchor="middle" fill="#17332e" fontFamily="Georgia,serif" fontSize="22">{title}</text>
            <text x="250" y="185" textAnchor="middle" fill="#284d43" fontFamily="sans-serif" fontSize="10" letterSpacing="3">{drive.state === "idle" ? "OPTICAL DRIVE READY" : "COVER ART UNAVAILABLE"}</text>
          </>}
          <circle cx="250" cy="250" r="211" fill={`url(#${id}-sheen)`} />
          <circle cx="250" cy="250" r="211" fill="none" stroke="#d5e5db" strokeOpacity=".7" strokeWidth="3" />
          <circle cx="250" cy="250" r="45" fill="#b1bcb3" fillOpacity=".72" stroke="#e6eee5" strokeOpacity=".65" />
          <circle cx="250" cy="250" r="31" fill="#58716b" fillOpacity=".5" stroke="#e5eee6" strokeOpacity=".4" />
          {!compact && <>
            <text x="250" y="395" textAnchor="middle" fill={drive.artwork ? "#f7eed8" : "#284d43"} fontFamily="sans-serif" fontSize="15" fontWeight="800" fontStyle="italic" letterSpacing="1">DVD</text>
            <text x="250" y="413" textAnchor="middle" fill={drive.artwork ? "#f7eed8" : "#284d43"} fontFamily="sans-serif" fontSize="7" letterSpacing="3">SAMPLE EDITION</text>
          </>}
        </g>
      </svg>
      <span className={styles.srOnly} role="progressbar" aria-label={`${drive.name} archive progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={drive.progress ?? undefined} aria-valuetext={drive.progress === null ? drive.phase : `${progress}% archived`} />
    </div>
  );
}
