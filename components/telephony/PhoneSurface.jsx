"use client";
import { useUiText } from "@/components/i18n/use-ui-text";
import clsx from "clsx";
import { Phone as IconPhone, PhoneOff as IconPhoneOff, Mic as IconMic, MicOff as IconMicOff, Pause as IconPause, Play as IconPlay, ChevronDown as IconChevronDown, PhoneForwarded as IconPhoneForwarded, UserCircle as IconContact, Hash as IconHash } from "lucide-react";

export function MiniPhoneSurface({telephonyStatus,callStatus,activeCall,callHeader = () => "",testInteractionId,callUI,isRinging,audioRef,connectionIndicator,headsetIndicator,isIncomingCall,incomingCallerDisplay,isOutboundCall,miniInputDisplay,shouldMarqueeMiniInput,setShowNumberModal,handleRejectCall,handleAnswerCall,isCallConnected,hangup,toggleMute,toggleHold,onTransfer,handoffButton,canCall,startCall,toggle,busy = false,disabledActions = [],dialUnavailableReason,transport = "webrtc",children}) {
  const tUi = useUiText();
  return (
    <div
      data-testid="voice-softphone"
      data-voice-ready={telephonyStatus === "connected" ? "true" : "false"}
      data-call-status={callStatus || "idle"}
      data-rtc-call-id={activeCall?.transport === "station" ? "" : activeCall?.id || ""}
      data-phone-transport={activeCall?.transport || transport}
      data-work-item-id={callHeader("x-cc-work-item-id")}
      data-offer-generation={callHeader("x-cc-offer-generation")}
      data-interaction-id={testInteractionId || ""}
      data-call-control-id={activeCall?.callControlId || activeCall?.call_control_id || ""}
      data-held={callUI.isHeld ? "true" : "false"}
      data-muted={callUI.isMuted ? "true" : "false"}
      className={`hidden sm:flex items-center gap-2 rounded-md bg-muted text-foreground border px-2 py-1 transition-all ${
        isRinging
          ? "border-telnyx-green shadow-[0_0_0_2px_rgba(34,211,110,0.3)] animate-pulse"
          : "border-border"
      }`}
    >
      <audio data-testid="voice-remote-audio" ref={audioRef} autoPlay playsInline className="hidden" />
      {connectionIndicator}
      {headsetIndicator}
      <button
        className="h-7 w-7 rounded-full grid place-items-center bg-zinc-700/70 text-white hover:bg-zinc-700"
        data-testid="voice-number-select" title={tUi("Select number from contacts")}
        onClick={() => setShowNumberModal(true)}
      >
        <IconContact className="h-4 w-4" />
      </button>
      <button
        type="button"
        disabled={Boolean(isIncomingCall && incomingCallerDisplay)}
        className={`relative h-[30px] w-40 overflow-hidden rounded border bg-background px-2 py-1 text-left text-xs outline-none ${
          isIncomingCall && incomingCallerDisplay
            ? "cursor-not-allowed border-orange-500/50 text-orange-500"
            : isOutboundCall
            ? "cursor-pointer border-emerald-500/50 text-foreground"
            : "cursor-pointer border-border text-foreground"
        }`}
        onClick={() => {
          if (!(isIncomingCall && incomingCallerDisplay)) {
            setShowNumberModal(true);
          }
        }}
        title={isIncomingCall && incomingCallerDisplay ? tUi("From: {value0}", { value0: incomingCallerDisplay }) : tUi("Click to select number")}
      >
        <span
          className={shouldMarqueeMiniInput ? "inline-block whitespace-nowrap" : "block truncate"}
          style={
            shouldMarqueeMiniInput
              ? { animation: "miniPhoneCallerMarquee 6s ease-in-out infinite alternate" }
              : undefined
          }
        >
          {miniInputDisplay || tUi("Phone number or SIP URI")}
        </span>
      </button>
      <style jsx global>{`
        @keyframes miniPhoneCallerMarquee {
          0%, 25% { transform: translateX(0); }
          75%, 100% { transform: translateX(calc(-100% + 9rem)); }
        }
      `}</style>
      {/* Show answer/reject buttons for incoming ringing calls */}
      {isRinging ? (
        <>
          <button
            className="h-7 w-7 rounded-full grid place-items-center bg-red-600 text-white"
            disabled={busy || disabledActions.includes("reject")} data-testid="voice-reject" title={tUi("Reject")}
            onClick={() => handleRejectCall()}
          >
            <IconPhoneOff className="h-4 w-4" />
          </button>
          <button
            className="h-7 w-7 rounded-full grid place-items-center bg-emerald-600 text-white"
            disabled={busy || disabledActions.includes("answer")} data-testid="voice-answer" title={tUi("Answer")}
            onClick={() => handleAnswerCall()}
          >
            <IconPhone className="h-4 w-4" />
          </button>
        </>
      ) : activeCall && !isCallConnected ? (
        <>
          {/* Show only disconnect button for outbound calls in progress (dialing/ringing) */}
          <button
            className="h-7 w-7 rounded-full grid place-items-center bg-red-600 text-white"
            disabled={busy || disabledActions.includes("disconnect")} data-testid="voice-disconnect" title={tUi("Disconnect")}
            onClick={hangup}
          >
            <IconPhoneOff className="h-4 w-4" />
          </button>
        </>
      ) : isCallConnected ? (
        <>
          {/* Show CTI buttons when call is connected/answered */}
          <button
            className="h-7 w-7 rounded-full grid place-items-center bg-zinc-700/70 text-white"
            disabled={busy || disabledActions.includes("mute")} data-testid="voice-mute" title={callUI.isMuted ? tUi("Unmute") : tUi("Mute")}
            onClick={toggleMute}
          >
            {callUI.isMuted ? (
              <IconMicOff className="h-4 w-4" />
            ) : (
              <IconMic className="h-4 w-4" />
            )}
          </button>
          <button
            className="h-7 w-7 rounded-full grid place-items-center bg-red-600 text-white"
            disabled={busy || disabledActions.includes("hangup")} data-testid="voice-hangup" title={tUi("Hang up")}
            onClick={hangup}
          >
            <IconPhoneOff className="h-4 w-4" />
          </button>
          <button
            className="h-7 w-7 rounded-full grid place-items-center bg-zinc-700/70 text-white"
            disabled={busy || disabledActions.includes("hold")} data-testid="voice-hold" title={callUI.isHeld ? tUi("Unhold") : tUi("Hold", undefined, "phone action")}
            onClick={toggleHold}
          >
            {callUI.isHeld ? (
              <IconPlay className="h-4 w-4" />
            ) : (
              <IconPause className="h-4 w-4" />
            )}
          </button>
          <button
            className="h-7 w-7 rounded-full grid place-items-center bg-zinc-700/70 text-white"
            disabled={busy || disabledActions.includes("transfer")} data-testid="voice-transfer" title={tUi("Transfer")}
            onClick={onTransfer}
          >
            <IconPhoneForwarded className="h-4 w-4" />
          </button>
          {handoffButton}
        </>
      ) : (
        <>
          {/* Show only dial button when idle */}
          <button
            className={`h-7 w-7 rounded-full grid place-items-center ${
              canCall
                ? "bg-emerald-600 text-white"
                : "bg-zinc-700/70 text-white/70"
            }`}
            data-testid="voice-dial" title={dialUnavailableReason ? tUi(dialUnavailableReason) : tUi("Call", undefined, "phone action")}
            onClick={startCall}
            disabled={!canCall || busy}
          >
            <IconPhone className="h-4 w-4" />
          </button>
        </>
      )}
      <button
        className="ml-1 h-7 w-7 rounded-full bg-zinc-700/70 text-white grid place-items-center"
        data-testid="voice-expand" title={tUi("Show phone")}
        onClick={toggle}
      >
        <IconChevronDown className="h-4 w-4" />
      </button>
      {children}
    </div>
  );
}

function CircleButton({ children, onClick, disabled, className, title }) {
  return (
    <button
      type="button"
      title={title}
      className={clsx(
        "h-12 w-12 rounded-full flex items-center justify-center text-white",
        "shadow-md active:scale-[0.98] transition-transform",
        disabled && "opacity-50 cursor-not-allowed",
        className
      )}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

export function FloatingPhoneSurface({toNumber,displayedFromNumber,isIncomingCall,isOutboundCall,isRinging,activeCall,isCallConnected,callUI,canCall,startCall,handleAnswerCall,handleRejectCall,hangup,toggleMute,toggleHold,onTransfer,setShowNumberModal,showDtmf,setShowDtmf,dtmfBuffer,keypadDigits,handleKeypadDigit,isCallActive,handoffBar,busy = false,disabledActions = [],dialUnavailableReason,notice,children}) {
  const tUi = useUiText();
  return (
    <div className="mx-auto w-full max-w-[280px] py-1 bg-zinc-900">
      <div className="relative flex flex-col items-center gap-4 rounded-2xl bg-zinc-900 p-4 text-white shadow-xl">
        <div className="w-full">
          <label className="mb-1 block text-[11px] text-zinc-300">{tUi("To")}</label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="h-8 w-8 rounded-lg border border-zinc-700 bg-zinc-900/60 text-white hover:bg-zinc-800 flex items-center justify-center"
              title={tUi("Select number from contacts")}
              onClick={() => setShowNumberModal(true)}
            >
              <IconContact className="h-4 w-4" />
            </button>
            <input
              className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900/60 px-2.5 py-1.5 text-[10px] text-white outline-none focus:border-zinc-500 cursor-pointer"
              placeholder={tUi("Phone number or SIP URI")}
              value={toNumber}
              readOnly
              onClick={() => setShowNumberModal(true)}
              title={tUi("Click to select number")}
              inputMode="text"
            />
          </div>
        </div>

        <div className="w-full">
          <label className="mb-1 block text-[11px] text-zinc-300">{tUi("From")}</label>
          <input
            className={clsx(
              "w-full rounded-lg border bg-zinc-900/60 px-2.5 py-1.5 text-[10px] outline-none cursor-not-allowed",
              isIncomingCall
                ? "border-orange-500/50 text-orange-500 focus:border-orange-500"
                : isOutboundCall
                ? "border-emerald-500/50 text-white focus:border-emerald-500"
                : "border-zinc-700 text-white focus:border-zinc-500"
            )}
            placeholder={tUi("Phone number or SIP URI")}
            value={displayedFromNumber || ""}
            readOnly
            title={isIncomingCall ? tUi("Incoming caller: {value0}", { value0: displayedFromNumber || "" }) : tUi("Voice number from your profile")}
            inputMode="text"
          />
        </div>

        {notice ? <p role="status" className="w-full text-xs leading-relaxed text-zinc-300">{notice}</p> : null}
        {/* Show answer/reject buttons for incoming ringing calls */}
        {isRinging ? (
          <div className="mt-1 grid w-full grid-cols-2 place-items-center gap-4">
            <div className="flex flex-col items-center gap-2">
              <CircleButton
                title={tUi("Reject")}
                className="bg-red-600"
                disabled={busy || disabledActions.includes("reject")} onClick={() => handleRejectCall()}
              >
                <IconPhoneOff className="h-5 w-5" />
              </CircleButton>
              <div className="text-[11px] text-zinc-300">{tUi("Reject")}</div>
            </div>
            <div className="flex flex-col items-center gap-2">
              <CircleButton
                title={tUi("Answer")}
                className="bg-emerald-600"
                disabled={busy || disabledActions.includes("answer")} onClick={() => handleAnswerCall()}
              >
                <IconPhone className="h-5 w-5" />
              </CircleButton>
              <div className="text-[11px] text-zinc-300">{tUi("Answer")}</div>
            </div>
          </div>
        ) : activeCall && !isCallConnected ? (
          /* Show only disconnect button for outbound calls in progress (dialing/ringing) */
          <div className="mt-1 flex w-full justify-center">
            <div className="flex flex-col items-center gap-2">
              <CircleButton
                title={tUi("Disconnect")}
                className="bg-red-600"
                disabled={busy || disabledActions.includes("hangup")} onClick={hangup}
              >
                <IconPhoneOff className="h-5 w-5" />
              </CircleButton>
              <div className="text-[11px] text-zinc-300">{tUi("Disconnect")}</div>
            </div>
          </div>
        ) : isCallConnected ? (
          /* Show CTI controls when call is connected/answered */
          <div className="mt-1 grid w-full grid-cols-4 place-items-center gap-2">
            <div className="flex flex-col items-center gap-2">
              <CircleButton
                title={callUI.isMuted ? tUi("Unmute") : tUi("Mute")}
                className="bg-zinc-700/70"
                disabled={busy || disabledActions.includes("mute")} onClick={toggleMute}
              >
                {callUI.isMuted ? (
                  <IconMicOff className="h-5 w-5" />
                ) : (
                  <IconMic className="h-5 w-5" />
                )}
              </CircleButton>
              <div className="text-[11px] text-zinc-300">
                {callUI.isMuted ? tUi("Unmute") : tUi("Mute")}
              </div>
            </div>

            <div className="flex flex-col items-center gap-2">
              <CircleButton title={tUi("End")} className="bg-red-600" disabled={busy || disabledActions.includes("hangup")} onClick={hangup}>
                <IconPhoneOff className="h-5 w-5" />
              </CircleButton>
              <div className="text-[11px] text-zinc-300">{tUi("End")}</div>
            </div>

            <div className="flex flex-col items-center gap-2">
              <CircleButton
                title={callUI.isHeld ? tUi("Unhold") : tUi("Hold", undefined, "phone action")}
                className="bg-zinc-700/70"
                disabled={busy || disabledActions.includes("hold")} onClick={toggleHold}
              >
                {callUI.isHeld ? (
                  <IconPlay className="h-5 w-5" />
                ) : (
                  <IconPause className="h-5 w-5" />
                )}
              </CircleButton>
              <div className="text-[11px] text-zinc-300">
                {callUI.isHeld ? tUi("Unhold") : tUi("Hold", undefined, "phone action")}
              </div>
            </div>

            <div className="flex flex-col items-center gap-2">
              <CircleButton
                title={tUi("Transfer")}
                className="bg-zinc-700/70"
                disabled={busy || disabledActions.includes("transfer")} onClick={onTransfer}
              >
                <IconPhoneForwarded className="h-5 w-5" />
              </CircleButton>
              <div className="text-[11px] text-zinc-300">{tUi("Transfer")}</div>
            </div>
          </div>
        ) : (
          /* Show only dial button when idle */
          <div className="mt-1 flex w-full justify-center">
            <div className="flex flex-col items-center gap-2">
              <CircleButton
                title={dialUnavailableReason ? tUi(dialUnavailableReason) : tUi("Call", undefined, "phone action")}
                className={clsx("bg-emerald-600", !canCall && "opacity-50")}
                onClick={startCall}
                disabled={!canCall || busy}
              >
                <IconPhone className="h-5 w-5" />
              </CircleButton>
              <div className="text-[11px] text-zinc-300">{tUi("Call", undefined, "phone action")}</div>
            </div>
          </div>
        )}
        <div className="w-full h-px bg-zinc-700/50"></div>

        <button
          type="button"
          className="w-full flex items-center justify-between px-1 py-1 text-[11px] text-zinc-300 hover:text-white"
          onClick={() => setShowDtmf((v) => !v)}
          data-testid="voice-dtmf-open" title={tUi("DTMF")}
        >
          <span className="flex items-center gap-1">
            <IconHash className="h-3 w-3" />
            <span>{tUi("DTMF")}</span>
          </span>
          <IconChevronDown
            className={clsx(
              "h-3 w-3 transition-transform duration-200",
              showDtmf && "rotate-180"
            )}
          />
        </button>

        {showDtmf && (
          <div className="w-full rounded-2xl bg-zinc-900/60 p-0">
            <div className="mb-1 min-h-[22px] min-w-[22px] break-all text-center text-[11px] text-zinc-200 bg-zinc-700/30 rounded-md px-5 py-1">
              {dtmfBuffer}
            </div>
            <div className="grid grid-cols-3 gap-3 mx-12 mt-3">
              {keypadDigits.flat().map((digit) => (
                <button
                  key={digit}
                  data-testid="voice-dtmf-digit" data-digit={digit}
                  onClick={() => handleKeypadDigit(digit)}
                  disabled={!isCallActive || busy || disabledActions.includes("dtmf")}
                  aria-disabled={!isCallActive || busy || disabledActions.includes("dtmf")}
                  className={clsx(
                    "h-10 w-10 rounded-full text-base text-white shadow active:scale-95",
                    isCallActive
                      ? "bg-zinc-800"
                      : "bg-zinc-800/50 cursor-not-allowed"
                  )}
                >
                  {digit}
                </button>
              ))}
            </div>
          </div>
        )}
        {handoffBar}
      </div>

      {children}
    </div>
  );
}
