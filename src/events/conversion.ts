import { last } from "lodash";

import {
  MoveLandedType,
  PlayerIndexedType,
  isDamaged,
  isGrabbed,
  calcDamageTaken,
  isInControl,
  didLoseStock,
  Timers,
  getSinglesPlayerPermutationsFromSettings,
} from "@slippi/slippi-js";
import { ConversionType, PostFrameUpdateType, FrameEntryType, GameStartType } from "../types";
import { Subject, Observable } from "rxjs";
import { RxSlpStream } from "../stream";
import { filter, switchMap } from "rxjs/operators";
import { withPreviousFrame } from "../operators/frames";

interface PlayerConversionState {
  conversion: ConversionType | null;
  move: MoveLandedType | null;
  resetCounter: number;
  lastHitAnimation: number | null;
}

interface ConversionEventPayload {
  combo: ConversionType;
  settings: GameStartType;
}

export class ConversionEvents {
  private stream$: Observable<RxSlpStream>;
  private settings: GameStartType;

  private playerPermutations = new Array<PlayerIndexedType>();
  private conversions = new Array<ConversionType>();
  private state = new Map<PlayerIndexedType, PlayerConversionState>();

  private conversionSource = new Subject<ConversionEventPayload>();
  public end$ = this.conversionSource.asObservable();

  private resetState(): void {
    this.playerPermutations = new Array<PlayerIndexedType>();
    this.state = new Map<PlayerIndexedType, PlayerConversionState>();
    this.conversions = new Array<ConversionType>();
  }

  public constructor(stream: Observable<RxSlpStream>) {
    this.stream$ = stream;

    // Reset the state on game start
    this.stream$.pipe(switchMap((s) => s.gameStart$)).subscribe((settings) => {
      this.resetState();
      // We only care about the 2 player games
      if (settings.players.length === 2) {
        const perms = getSinglesPlayerPermutationsFromSettings(settings);
        this.setPlayerPermutations(perms);
        this.settings = settings;
      }
    });

    // Handle the frame processing
    this.stream$
      .pipe(
        switchMap((s) => s.playerFrame$),
        // We only want the frames for two player games
        filter((frame) => {
          const players = Object.keys(frame.players);
          return players.length === 2;
        }),
        withPreviousFrame(),
      )
      .subscribe(([prevFrame, latestFrame]) => {
        this.processFrame(prevFrame, latestFrame);
      });
  }

  public setPlayerPermutations(playerPermutations: PlayerIndexedType[]): void {
    this.playerPermutations = playerPermutations;
    this.playerPermutations.forEach((indices) => {
      const playerState: PlayerConversionState = {
        conversion: null,
        move: null,
        resetCounter: 0,
        lastHitAnimation: null,
      };
      this.state.set(indices, playerState);
    });
  }

  public processFrame(prevFrame: FrameEntryType, latestFrame: FrameEntryType): void {
    this.playerPermutations.forEach((indices) => {
      const state = this.state.get(indices);
      const terminated = handleConversionCompute(state, indices, prevFrame, latestFrame, this.conversions);
      if (terminated) {
        this.conversionSource.next({
          combo: last(this.conversions),
          settings: this.settings,
        });
      }
    });
  }
}

function handleConversionCompute(
  state: PlayerConversionState,
  indices: PlayerIndexedType,
  prevFrame: FrameEntryType,
  latestFrame: FrameEntryType,
  conversions: ConversionType[],
): boolean {
  const playerFrame: PostFrameUpdateType = latestFrame.players[indices.playerIndex].post;
  const prevPlayerFrame: PostFrameUpdateType = prevFrame.players[indices.playerIndex].post;
  const opponentFrame: PostFrameUpdateType = latestFrame.players[indices.opponentIndex].post;
  const prevOpponentFrame: PostFrameUpdateType = prevFrame.players[indices.opponentIndex].post;

  const opntIsDamaged = isDamaged(opponentFrame.actionStateId);
  const opntIsGrabbed = isGrabbed(opponentFrame.actionStateId);
  const opntDamageTaken = calcDamageTaken(opponentFrame, prevOpponentFrame);

  // Keep track of whether actionState changes after a hit. Used to compute move count
  // When purely using action state there was a bug where if you did two of the same
  // move really fast (such as ganon's jab), it would count as one move. Added
  // the actionStateCounter at this point which counts the number of frames since
  // an animation started. Should be more robust, for old files it should always be
  // null and null < null = false
  const actionChangedSinceHit = playerFrame.actionStateId !== state.lastHitAnimation;
  const actionCounter = playerFrame.actionStateCounter;
  const prevActionCounter = prevPlayerFrame.actionStateCounter;
  const actionFrameCounterReset = actionCounter < prevActionCounter;
  if (actionChangedSinceHit || actionFrameCounterReset) {
    state.lastHitAnimation = null;
  }

  // If opponent took damage and was put in some kind of stun this frame, either
  // start a conversion or
  if (opntIsDamaged || opntIsGrabbed) {
    if (!state.conversion) {
      state.conversion = {
        playerIndex: indices.playerIndex,
        opponentIndex: indices.opponentIndex,
        startFrame: playerFrame.frame,
        endFrame: null,
        startPercent: prevOpponentFrame.percent || 0,
        currentPercent: opponentFrame.percent || 0,
        endPercent: null,
        moves: [],
        didKill: false,
        openingType: "unknown", // Will be updated later
      };

      conversions.push(state.conversion);
    }

    if (opntDamageTaken) {
      // If animation of last hit has been cleared that means this is a new move. This
      // prevents counting multiple hits from the same move such as fox's drill
      if (!state.lastHitAnimation) {
        state.move = {
          frame: playerFrame.frame,
          moveId: playerFrame.lastAttackLanded,
          hitCount: 0,
          damage: 0,
        };

        state.conversion.moves.push(state.move);
      }

      if (state.move) {
        state.move.hitCount += 1;
        state.move.damage += opntDamageTaken;
      }

      // Store previous frame animation to consider the case of a trade, the previous
      // frame should always be the move that actually connected... I hope
      state.lastHitAnimation = prevPlayerFrame.actionStateId;
    }
  }

  if (!state.conversion) {
    // The rest of the function handles conversion termination logic, so if we don't
    // have a conversion started, there is no need to continue
    return;
  }

  const opntInControl = isInControl(opponentFrame.actionStateId);
  const opntDidLoseStock = didLoseStock(opponentFrame, prevOpponentFrame);

  // Update percent if opponent didn't lose stock
  if (!opntDidLoseStock) {
    state.conversion.currentPercent = opponentFrame.percent || 0;
  }

  if (opntIsDamaged || opntIsGrabbed) {
    // If opponent got grabbed or damaged, reset the reset counter
    state.resetCounter = 0;
  }

  const shouldStartResetCounter = state.resetCounter === 0 && opntInControl;
  const shouldContinueResetCounter = state.resetCounter > 0;
  if (shouldStartResetCounter || shouldContinueResetCounter) {
    // This will increment the reset timer under the following conditions:
    // 1) if we were punishing opponent but they have now entered an actionable state
    // 2) if counter has already started counting meaning opponent has entered actionable state
    state.resetCounter += 1;
  }

  let shouldTerminate = false;

  // Termination condition 1 - player kills opponent
  if (opntDidLoseStock) {
    state.conversion.didKill = true;
    shouldTerminate = true;
  }

  // Termination condition 2 - conversion resets on time
  if (state.resetCounter > Timers.PUNISH_RESET_FRAMES) {
    shouldTerminate = true;
  }

  // If conversion should terminate, mark the end states and add it to list
  if (shouldTerminate) {
    state.conversion.endFrame = playerFrame.frame;
    state.conversion.endPercent = prevOpponentFrame.percent || 0;

    state.conversion = null;
    state.move = null;
  }

  return shouldTerminate;
}
