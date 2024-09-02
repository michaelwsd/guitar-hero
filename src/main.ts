import "./style.css";
import { fromEvent, from, interval, merge, of, Subscription } from "rxjs";
import {
    map,
    filter,
    scan,
    concatMap,
    delay,
    groupBy,
    mergeMap,
    toArray,
    concatWith,
} from "rxjs/operators";
import * as Tone from "tone";
import { SampleLibrary } from "./tonejs-instruments";

/** Constants */
const Viewport = {
    CANVAS_WIDTH: 200,
    CANVAS_HEIGHT: 400,
} as const;

const Constants = {
    TICK_RATE_MS: 10,
    SONG_NAME: "SleepingBeauty",
    NOTE_BOUND: Viewport.CANVAS_HEIGHT - 50,
    TAIL_BOUND: 1,
} as const;

const Note = {
    RADIUS: 0.07 * Viewport.CANVAS_WIDTH,
    TAIL_WIDTH: 10,
};

/** User input */
type Key = "KeyH" | "KeyJ" | "KeyK" | "KeyL";

type Event = "keydown" | "keyup" | "keypress";

/** Utility functions */
// RANDOM NUMBER
abstract class RNG {
    // LCG using GCC's constants
    private static m = 0x80000000;
    private static a = 1103515245;
    private static c = 12345;

    public static hash = (seed: number) => (RNG.a * seed + RNG.c) % RNG.m;

    // Takes hash value and scales it to the range [0, 1]
    public static scale = (hash: number) => (2 * hash) / (RNG.m - 1) / 2;
}

// PLAY A NORMAL NOTE
const playNote = (note: Note, samples: { [key: string]: Tone.Sampler }) => {
    samples[note.instrument_name].triggerAttackRelease(
        Tone.Frequency(note.pitch, "midi").toNote(),
        note.end - note.start,
        undefined,
        note.velocity,
    );
};

// STOP PLAYING A TAIL NOTE
const stopTailNote = (note: Note, samples: { [key: string]: Tone.Sampler }) => {
    samples[note.instrument_name].triggerRelease(
        Tone.Frequency(note.pitch, "midi").toNote(),
    );
};

// PLAY A TAIL NOTE
const playTailNote = (note: Note, samples: { [key: string]: Tone.Sampler }) => {
    samples[note.instrument_name].triggerAttack(
        Tone.Frequency(note.pitch, "midi").toNote(),
    );
};

// ASSIGN NOTE TO A COLUMN BASED ON PITCH
function getColumn(note: Note) {
    const selector = note.pitch % 4;
    const column = ["20%", "40%", "60%", "80%"];
    const color = ["green", "red", "blue", "yellow"];
    return { cx: column[selector], color: color[selector] };
}

// ACTIONS MODIFY STATE
interface Action {
    apply(s: State): State;
}

// TICK ACTION
class Tick implements Action {
    constructor(public readonly elapsed: number) {}

    apply(s: State): State {
        return tick(s);
    }
}

// EMIT NOTE
class EmitNotes implements Action {
    constructor(public readonly notes: ReadonlyArray<Note>) {}

    apply(s: State): State {
        const endGame = this.notes.length === 0; // check endgame

        // add the array of emitted notes to the current states with position initialised to 0
        return tick({
            ...s,
            gameEnd: endGame,
            currNotes: s.currNotes.concat(
                this.notes.map((currNote: Note) => ({
                    note: currNote,
                    position: 0,
                })),
            ),
        });
    }
}

// BUTTON DOWN ACTION
class ButtonDown implements Action {
    constructor(public readonly columnColour: string) {}

    apply(s: State) {
        // filter the array of valid clicked notes > 320
        const filteredNotes = s.currNotes.filter(
            (noteState) =>
                noteState.position > 320 &&
                getColumn(noteState.note).color === this.columnColour &&
                noteState.note.user_played &&
                !noteState.note.clicked &&
                !noteState.note.missed,
        );

        // check if any of the valid notes are tail notes
        const tailNotes = filteredNotes.filter(
            (noteState) => noteState.note.tail.hasTail,
        ).length;

        // update score (increase if no tail notes)
        const newScore =
            filteredNotes.length > 0 && tailNotes == 0
                ? s.score + 100
                : s.score;

        // update combo (no change if there are tail notes, 0 if no valid & tail notes)
        const newCombo =
            newScore > s.score ? s.combo + 1 : tailNotes > 0 ? s.combo : 0;

        // update score multiplier
        const newMultiplier = 1 + Math.floor(newCombo / 10) * 0.2;

        // construct a new note if no match
        const newNote =
            newScore + tailNotes > s.score // we clicked a right note (tailed or non-tailed)
                ? []
                : [
                      {
                          note: this.generateRandomNote(s.seed),
                          position: Constants.NOTE_BOUND,
                      },
                  ];

        // update seed
        const newSeed = RNG.hash(s.seed);

        // return new state
        return {
            ...s,
            score: newScore + (100 * newMultiplier - 100),
            combo: newCombo,
            multiplier: newMultiplier,
            seed: newSeed,
            currNotes: s.currNotes
                .map((noteState) => ({
                    ...noteState,
                    note: {
                        ...noteState.note,
                        clicked:
                            // for all notes > 320 in that column, change clicked property to true
                            noteState.position > 320 &&
                            getColumn(noteState.note).color ===
                                this.columnColour &&
                            noteState.note.user_played
                                ? true
                                : noteState.note.clicked,
                    },
                }))
                .concat(newNote), // add the random note if there is one
        };
    }

    // function that generates a random note
    private generateRandomNote(seed: number): Note {
        const pitch = Math.floor(RNG.scale(seed) * 80 + 10);
        const velocity = Math.floor(RNG.scale(seed) * 30 + 10);
        const duration = RNG.scale(seed) * 0.5;

        return {
            id: 1,
            user_played: false,
            instrument_name: "piano",
            velocity: velocity,
            pitch: pitch,
            start: 0,
            end: duration,
            clicked: false,
            missed: false,
            tail: {
                hasTail: false,
                tailStart: 0,
                tailLength: 0,
                tailCompleted: true,
            },
        };
    }
}

// BUTTON UP ACTION
class ButtonUp implements Action {
    constructor(public readonly columnColour: string) {}

    apply(s: State): State {
        /*
        Logic:
        - For any up clicks, if there's currently a clicked note with incomplete tail (clicked note must have tail),
        if that note corresponds to the the column & if tail length is correct & if note not missed, add score and mark tail as completed,
        otherwise reset combo, mark tail as completed
        */

        // get all the notes that have tails, are clicked but not tail completed
        const filteredNotes = s.currNotes.filter(
            (noteState) =>
                noteState.note.tail.hasTail &&
                getColumn(noteState.note).color === this.columnColour &&
                noteState.note.user_played &&
                noteState.note.clicked &&
                !noteState.note.missed &&
                !noteState.note.tail.tailCompleted,
        );

        // get the notes that are released at the correct time, with +/- radius leeway
        const correctNotes = filteredNotes.filter(
            (noteState) =>
                noteState.note.tail.tailLength > -Note.RADIUS &&
                noteState.note.tail.tailLength < Note.RADIUS,
        );

        // update score (if valid notes are clicked at the right time)
        const newScore = correctNotes.length > 0 ? s.score + 100 : s.score;

        // update combo
        const newCombo =
            correctNotes.length > 0
                ? s.combo + 1
                : filteredNotes.length > 0
                  ? 0
                  : s.combo;

        // update multiplier
        const newMultiplier = newCombo > 0 ? s.multiplier : 1;

        // return new state
        return {
            ...s,
            score: newScore + (100 * newMultiplier - 100),
            combo: newCombo,
            multiplier: newMultiplier,
            currNotes: s.currNotes.map((noteState) => {
                // mark all valid tail notes as tailCompleted, regardless of if it's released at the right time
                const isInFilteredNotes = filteredNotes.some(
                    (filteredNote) =>
                        filteredNote.note.id === noteState.note.id,
                );
                return {
                    ...noteState,
                    note: {
                        ...noteState.note,
                        tail: {
                            ...noteState.note.tail,
                            tailCompleted:
                                isInFilteredNotes ||
                                noteState.note.tail.tailCompleted,
                        },
                    },
                };
            }),
        };
    }
}

// ADD TAIL SVG
function updateTail(note: Note) {
    const svg = document.querySelector("#svgCanvas") as SVGGraphicsElement &
        HTMLElement;
    const tail = document.getElementById(
        String(`tail-${note.id}`),
    ) as HTMLElement;
    const { cx, color } = getColumn(note);

    if (tail) {
        svg.removeChild(tail);
    }

    if (note.tail.hasTail && note.tail.tailLength > 0) {
        const svgTail = createSvgElement(svg.namespaceURI, "rect", {
            id: `tail-${note.id}`,
            x: `${String(parseFloat(cx) - 2)}%`,
            y: String(note.tail.tailStart - note.tail.tailLength),
            width: `${Note.TAIL_WIDTH}`,
            height: String(note.tail.tailLength),
            style: `fill: ${color}; stroke: lightgrey; stroke-width: 2px;`,
            class: "shadow",
        });
        svg.appendChild(svgTail);
    }
}

// REDUCE STATE
const reduceState = (s: State, action: Action) => action.apply(s);

/** State processing */
// TAIL TYPE
type Tail = Readonly<{
    hasTail: boolean;
    tailStart: number;
    tailLength: number;
    tailCompleted: boolean;
}>;

// NOTE TYPE
type Note = Readonly<{
    id: number;
    user_played: boolean;
    instrument_name: string;
    velocity: number;
    pitch: number;
    start: number;
    end: number;
    clicked: boolean;
    missed: boolean;
    tail: Tail;
}>;

// STATE OF A NOTE
type NoteState = Readonly<{
    note: Note;
    position: number;
}>;

// STATE TYPE
type State = Readonly<{
    gameEnd: boolean;
    currNotes: ReadonlyArray<NoteState>;
    score: number;
    combo: number;
    multiplier: number;
    seed: number;
}>;

// INITIAL STATE
const initialState: State = {
    gameEnd: false,
    currNotes: [],
    score: 0,
    combo: 0,
    multiplier: 1,
    seed: 1,
} as const;

/**
 * Updates the state by proceeding with one time step.
 *
 * @param s Current state
 * @returns Updated state
 */
const tick = (s: State) => {
    // get all new notes that are missed (not missed already)
    const missedNotes = s.currNotes.filter((noteState) => {
        return (
            noteState.position > Constants.NOTE_BOUND &&
            noteState.note.user_played &&
            !noteState.note.missed &&
            !noteState.note.clicked
        );
    }).length;

    // mark the notes that are above 350, no tails as missed, set combo to 0 and multiplier to 1
    const updatedNotes = s.currNotes.map((noteState) => {
        // different to the above one, doesn't consider previously missed notes
        const missed =
            noteState.note.user_played &&
            noteState.position > Constants.NOTE_BOUND &&
            !noteState.note.clicked;

        return {
            ...noteState,
            position: noteState.position + 1, // update position of notes
            note: {
                ...noteState.note,
                missed: missed || noteState.note.missed,
                tail: {
                    ...noteState.note.tail,
                    // update tail position
                    tailStart:
                        noteState.note.tail.tailStart > Constants.NOTE_BOUND
                            ? noteState.note.tail.tailStart
                            : noteState.note.tail.tailStart + 1,

                    // update tail length
                    tailLength:
                        noteState.note.tail.tailStart > Constants.NOTE_BOUND
                            ? noteState.note.tail.tailLength - 1
                            : noteState.note.tail.tailLength,

                    // check if tail has elapsed
                    tailCompleted:
                        (noteState.note.tail.hasTail &&
                            noteState.note.tail.tailLength < -Note.RADIUS) ||
                        noteState.note.tail.tailCompleted,
                },
            },
        };
    });

    // remove the notes that are tail completed (to prevent duplicate pitches)
    const filteredNotes = updatedNotes.filter(
        (noteState) =>
            noteState.note.tail.tailLength > -Note.RADIUS ||
            !noteState.note.tail.tailCompleted,
    );

    // return new state
    return {
        ...s,
        currNotes: filteredNotes,
        combo: missedNotes > 0 ? 0 : s.combo,
        multiplier: missedNotes > 0 ? 1 : s.multiplier,
    };
};

/** Rendering (side effects) */

/**
 * Displays a SVG element on the canvas. Brings to foreground.
 * @param elem SVG element to display
 */
const show = (elem: SVGGraphicsElement) => {
    elem.setAttribute("visibility", "visible");
    elem.parentNode!.appendChild(elem);
};

/**
 * Hides a SVG element on the canvas.
 * @param elem SVG element to hide
 */
const hide = (elem: SVGGraphicsElement) =>
    elem.setAttribute("visibility", "hidden");

/**
 * Creates an SVG element with the given properties.
 *
 * See https://developer.mozilla.org/en-US/docs/Web/SVG/Element for valid
 * element names and properties.
 *
 * @param namespace Namespace of the SVG element
 * @param name SVGElement name
 * @param props Properties to set on the SVG element
 * @returns SVG element
 */
const createSvgElement = (
    namespace: string | null,
    name: string,
    props: Record<string, string> = {},
) => {
    const elem = document.createElementNS(namespace, name) as SVGElement;
    Object.entries(props).forEach(([k, v]) => elem.setAttribute(k, v));
    return elem;
};

/**
 * This is the function called on page load. Your main game loop
 * should be called here.
 */
export function main(
    csvContents: string,
    samples: { [key: string]: Tone.Sampler },
) {
    // Canvas elements
    const restart = document.getElementById("restartButton");
    const svg = document.querySelector("#svgCanvas") as SVGGraphicsElement &
        HTMLElement;
    const gameover = document.querySelector("#gameOver") as SVGGraphicsElement &
        HTMLElement;

    svg.setAttribute("height", `${Viewport.CANVAS_HEIGHT}`);
    svg.setAttribute("width", `${Viewport.CANVAS_WIDTH}`);

    // Text fields
    const multiplier = document.querySelector("#multiplierText") as HTMLElement;
    const scoreText = document.querySelector("#scoreText") as HTMLElement;
    const comboText = document.querySelector("#comboText") as HTMLElement;
    const highScoreText = document.querySelector(
        "#highScoreText",
    ) as HTMLElement;

    /** User input */
    const key$ = (e: Event, k: Key) =>
        fromEvent<KeyboardEvent>(document, e).pipe(
            filter(({ code }) => code === k),
            filter(({ repeat }) => !repeat),
        );

    // keydown clicks
    const greenkeyDown$ = key$("keydown", "KeyH").pipe(
        map((_) => new ButtonDown("green")),
    );
    const redKeyDown$ = key$("keydown", "KeyJ").pipe(
        map((_) => new ButtonDown("red")),
    );
    const blueKeyDown$ = key$("keydown", "KeyK").pipe(
        map((_) => new ButtonDown("blue")),
    );
    const yellowKeyDown$ = key$("keydown", "KeyL").pipe(
        map((_) => new ButtonDown("yellow")),
    );

    // keyup clicks
    const greenkeyUp$ = key$("keyup", "KeyH").pipe(
        map((_) => new ButtonUp("green")),
    );
    const redKeyUp$ = key$("keyup", "KeyJ").pipe(
        map((_) => new ButtonUp("red")),
    );
    const blueKeyUp$ = key$("keyup", "KeyK").pipe(
        map((_) => new ButtonUp("blue")),
    );
    const yellowKeyUp$ = key$("keyup", "KeyL").pipe(
        map((_) => new ButtonUp("yellow")),
    );

    /** Determines the rate of time steps */
    const tick$ = interval(Constants.TICK_RATE_MS).pipe(
        map((elapsed) => new Tick(elapsed)),
    );

    /**
     * Renders the current state to the canvas.
     *
     * In MVC terms, this updates the View using the Model.
     *
     * @param s Current state
     */
    const render = (s: State, prevHighScore: number) => {
        s.currNotes.forEach((noteState) => {
            // case if the note is not user played, simple play the note
            if (
                !noteState.note.user_played &&
                noteState.position == Constants.NOTE_BOUND
            ) {
                playNote(noteState.note, samples);

                // case if the note is user played & has been clicked
            } else if (noteState.note.user_played && noteState.note.clicked) {
                // check circle svg
                const circle = document.getElementById(
                    String(noteState.note.id),
                ) as HTMLElement;

                // play the note based on whether it's a tail note or not
                if (circle) {
                    if (!noteState.note.tail.hasTail) {
                        playNote(noteState.note, samples);
                    } else {
                        playTailNote(noteState.note, samples);
                    }
                    // remove circle
                    svg.removeChild(circle);

                    // if the tail note is tail completed, stop playing the note
                } else if (noteState.note.tail.tailCompleted) {
                    stopTailNote(noteState.note, samples);
                }

                // update tail svg
                updateTail(noteState.note);

                // case if the note is not clicked
            } else if (noteState.note.user_played) {
                // add note to canvas
                const circle = document.getElementById(
                    String(noteState.note.id),
                ) as HTMLElement;

                // remove circle if it exists
                if (circle) {
                    svg.removeChild(circle);
                }

                // update tail
                updateTail(noteState.note);

                // add the new note only if it's still within canvas
                if (noteState.position < Constants.NOTE_BOUND) {
                    const { cx, color } = getColumn(noteState.note);
                    const svgNote = createSvgElement(
                        svg.namespaceURI,
                        "circle",
                        {
                            id: String(noteState.note.id),
                            r: `${Note.RADIUS}`,
                            cx: cx,
                            cy: String(noteState.position),
                            style: `fill: ${color}`,
                            class: "shadow",
                        },
                    );
                    // add svg
                    svg.appendChild(svgNote);
                }
            }
        });
        // display text elements
        scoreText.innerHTML = String(s.score);
        comboText.innerHTML = String(`${s.combo}x`);
        multiplier.innerHTML = String(s.multiplier);
        highScoreText.innerHTML = String(prevHighScore);
    };

    // parse the notes
    const notes$ = from(csvContents.trim().split("\n").slice(1)).pipe(
        map((line: string) => line.split(",")),
        scan(
            (acc: Note, currNote: string[]) =>
                ({
                    id: acc.id + 1,
                    user_played: currNote[0] === "True",
                    instrument_name: currNote[1],
                    velocity: parseInt(currNote[2]) / 127,
                    pitch: parseInt(currNote[3], 10),
                    start: parseFloat(currNote[4]),
                    end: parseFloat(currNote[5]),
                    clicked: false,
                    missed: false,
                    tail: {
                        hasTail:
                            parseFloat(currNote[5]) - parseFloat(currNote[4]) >
                            Constants.TAIL_BOUND
                                ? true
                                : false,
                        tailStart: 0,
                        tailLength: Math.floor(
                            (1000 *
                                (parseFloat(currNote[5]) -
                                    parseFloat(currNote[4]))) /
                                Constants.TICK_RATE_MS,
                        ),
                        tailCompleted: false,
                    },
                }) as Note,
            { id: 0 } as Note,
        ),
    );

    // group notes with the same start time into a new flat observable stream
    const groupedNotes$ = notes$.pipe(
        groupBy((note) => note.start), // group notes by start time
        mergeMap((group$) => group$.pipe(toArray())),
    );

    // delay each group of notes based on the difference from the previous group's start time
    const timedNotes$ = groupedNotes$.pipe(
        scan<
            ReadonlyArray<Note>,
            {
                prevStartTime: number | null;
                delayTime: number;
                group: ReadonlyArray<Note>;
            }
        >(
            (acc, currGroup) => {
                const groupStartTime = currGroup[0].start;
                const delayM =
                    acc.prevStartTime !== null
                        ? (currGroup[0].start - acc.prevStartTime) * 1000
                        : 0;
                return {
                    prevStartTime: groupStartTime,
                    delayTime: delayM,
                    group: currGroup,
                };
            },
            { prevStartTime: null, delayTime: 0, group: [] },
        ),
        concatMap(({ group, delayTime }) => of(group).pipe(delay(delayTime))),
        concatWith(of([]).pipe(delay(5000))), // empty observable to denote endgame
    );

    // add new notes emitted to the state and display on the canvas
    const emitNotes$ = timedNotes$.pipe(map((notes) => new EmitNotes(notes)));

    // merge all streams
    const allStreams$ = merge(
        tick$,
        emitNotes$,
        greenkeyDown$,
        redKeyDown$,
        blueKeyDown$,
        yellowKeyDown$,
        greenkeyUp$,
        redKeyUp$,
        blueKeyUp$,
        yellowKeyUp$,
    );

    // reduce states
    const state$ = allStreams$.pipe(scan(reduceState, initialState));

    // elements for restarting the game
    const subscription: Subscription[] = [];
    const highScore: number[] = [0];

    // run the game
    const startStream = (highScore: number[]) => {
        subscription[0] = state$.subscribe((s: State) => {
            render(s, highScore[0]);
            if (s.gameEnd) {
                restart?.classList.remove("hidden");
                highScore[0] = highScore[0] > s.score ? highScore[0] : s.score;
                show(gameover);
            } else {
                hide(gameover);
            }
        });
    };

    // start the game
    startStream(highScore);

    // returns a new function used for restarting the game
    return {
        restart: () => {
            hide(gameover);
            if (subscription[0]) {
                subscription[0].unsubscribe();
            }
            startStream(highScore);
        },
    };
}

// display keys when clicked
function showKeys() {
    function showKey(k: Key) {
        const arrowKey = document.getElementById(k);
        // getElement might be null, in this case return without doing anything
        if (!arrowKey) return;
        const o = (e: Event) =>
            fromEvent<KeyboardEvent>(document, e).pipe(
                filter(({ code }) => code === k),
            );
        o("keydown").subscribe((e) => arrowKey.classList.add("highlight"));
        o("keyup").subscribe((_) => arrowKey.classList.remove("highlight"));
    }
    showKey("KeyH");
    showKey("KeyJ");
    showKey("KeyK");
    showKey("KeyL");
}

// The following simply runs your main function on window load.  Make sure to leave it in place.
// You should not need to change this, beware if you are.
if (typeof window !== "undefined") {
    // Load in the instruments and then start your game!
    const samples = SampleLibrary.load({
        instruments: [
            "bass-electric",
            "violin",
            "piano",
            "trumpet",
            "saxophone",
            "trombone",
            "flute",
        ], // SampleLibrary.list,
        baseUrl: "samples/",
    });

    // changed startGame logic
    const startGame = (contents: string) => {
        const startButton = document.getElementById(
            "startButton",
        ) as HTMLElement;
        const restartButton = document.getElementById(
            "restartButton",
        ) as HTMLElement;

        // hide the restart button until game ends
        restartButton.classList.add("hidden");
        const game: any[] = [];

        // add start button listener
        startButton.addEventListener(
            "click",
            function () {
                startButton.classList.add("hidden");
                game[0] = main(contents, samples);
                showKeys();
            },
            { once: true },
        );

        // add restart button listener
        restartButton.addEventListener("click", function () {
            restartButton.classList.add("hidden");
            if (game[0]) {
                game[0].restart();
            }
        });
    };

    const { protocol, hostname, port } = new URL(import.meta.url);
    const baseUrl = `${protocol}//${hostname}${port ? `:${port}` : ""}`;

    Tone.ToneAudioBuffer.loaded().then(() => {
        for (const instrument in samples) {
            samples[instrument].toDestination();
            samples[instrument].release = 0.5;
        }

        fetch(`${baseUrl}/assets/${Constants.SONG_NAME}.csv`)
            .then((response) => response.text())
            .then((text) => startGame(text))
            .catch((error) =>
                console.error("Error fetching the CSV file:", error),
            );
    });
}
