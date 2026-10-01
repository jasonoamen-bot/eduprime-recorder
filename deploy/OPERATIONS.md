# How class recording works, what it costs, and who looks after it

*A plain-English guide for EasyWay. Status (1 Oct 2026): the recorder, the tail-loss fix and the automatic server switch-on/off are built and tested on a real Linode account. Nothing is live yet: it still needs the scheduler, the LMS "which server?" link and a pilot (section 9).*

## 1. The idea in one paragraph
Today LiveKit records every class and charges about **$1.20 per class-hour**. We built our own recorder: a program that quietly joins each class like an invisible student, films it, and saves the video to Backblaze, exactly where the Watch shelf already looks. LiveKit stays for the live classes themselves. The recorder needs a computer with enough power; we rent that computer **by the hour**, only while classes are on.

## 2. What we rent, and why only during class hours
A rented server ("cloud server") is billed per hour it exists. A strong enough server (4 dedicated cores) costs about **$0.14 an hour**, or about **$100 a month if left on all month**. But classes only happen a few hours a day, so we create a server just before classes and delete it afterwards:

| When | What happens | Cost |
|---|---|---|
| Night and weekends with no class | No server exists | **$0** |
| Shortly before a class slot | A server is created automatically | about $0.14 per hour |
| After the slot ends and recordings are saved | The server is deleted automatically | stops |

Your timetable has four slots: Morning 10:00-13:00, Afternoon 13:00-15:00, Evening 17:00-19:00 (Mon-Fri) and Saturday 10:00-14:00. Roughly **200 server-hours a month** if we covered every slot, which is about **$30-75 a month** depending on how much power each class really needs (the load test on a rented server settles that).

## 3. How the automatic switch-on/off works (built; tested on the real account)
*Proven on 1 Oct 2026: the fleet manager created a small server by itself, it was answering in about 6 minutes, and it deleted it again when no class was due. Cost of that test: about $0.05. Commands: `npm run fleet -- plan | status | tick [--apply] | teardown [--apply] | release`. Everything that spends or deletes money is a **dry run unless `--apply`** is given. A 28-day simulation of the current timetable costs about **$38 per month**, covers every class, and leaves nothing running at night.*
**Nobody clicks anything.** A small scheduled job inside the LMS (the LMS already runs scheduled jobs) does this:

1. **About 15 minutes before a slot**, it looks at the day's timetable. If classes are planned, it asks the server company (Hetzner) to create a server from a saved copy ("snapshot") that already has the recorder installed. That takes about 1-2 minutes.
2. It waits until the new server says "I'm ready", and adds it to the LMS's list of recorders.
3. **When a tutor starts a class**, the LMS asks a recorder with free space to record it. If none is free, or none is up, the LMS uses **LiveKit's recording for that class** (the safety net that exists today).
4. **After the slot ends, and once every recording is saved**, plus a 20-minute buffer, the job deletes the server.
5. **A safety sweep** runs every few hours: any server older than 6 hours is deleted, so a forgotten server can never run for days.

Bigger mornings (several levels at once) need more than one server; the job creates as many as the timetable needs.

## 4. A normal day, as it looks from outside
- 09:45: a server appears (nobody notices).
- 10:00: tutors open their classes; the recorder joins each one silently.
- 13:00-13:30: classes end; videos finish uploading; the Watch shelf gets the new recordings and students get their usual "your class recording is ready" notification.
- about 13:50: the server is deleted.
- Staff and students see **nothing different** from today.

## 5. What can go wrong, and what happens
| Problem | What happens | Cost of the problem |
|---|---|---|
| The server fails to start | The LMS falls back to LiveKit recording for that class | LiveKit's normal rate for that class |
| Every recorder is full | Extra classes use LiveKit recording | LiveKit's normal rate for those classes |
| The recorder crashes mid-class | It resumes by itself within about 1-2 minutes; that gap is lost. Admins get a notification | a short gap in one recording |
| The server company has an outage | Falls back to LiveKit | as above |
| A server is forgotten | The 6-hour safety sweep deletes it | at most about $0.85 (6 hours) |
| The recorder cannot save to Backblaze | Admins get the existing "A class recording failed" alert; the file is kept on the server and retried | none |

Important: **the safety net is always LiveKit**, so a recording problem should never mean a class goes unrecorded.

## 6. Who looks after what
| Who | Job | How often |
|---|---|---|
| **Nobody** | Start and stop servers, record, upload, publish | Every class, automatic |
| **EasyWay admin** | Notice if a class has no recording (there is already a failure alert); glance at the monthly bill | Monthly, about 10 minutes |
| **Whoever holds the Hetzner account** | Pay the bill; keep the payment card valid; keep the account email working | Monthly |
| **Developer (Claude/the dev team)** | Update the recorder when the LMS changes; refresh the saved server copy for security updates; rotate keys; watch reliability | Quarterly, or when something changes |

## 7. Running costs you will actually see
1. **Hetzner servers:** about $30-75 a month (depends on the load test).
2. **A tiny saved server copy:** under $1 a month.
3. **Backblaze storage:** unchanged, the same as now.
4. **LiveKit:** drops back to the plan price (about $33) plus participant time; the recording charge goes away.
5. **No new software licences.** Everything used is free or already paid for.

## 8. What would make this not worth it
- If one class turns out to need far more power than measured, the saving shrinks.
- If recording volume drops below about 40 hours a month, LiveKit's recording charge (about $48) is small enough that the extra moving parts may not be worth it.
Both are checked before anything goes live: the rented-server test gives the real numbers.

## 9. What exists today vs what is still to build
- **Built and tested:** the recorder, its connection to LiveKit and Backblaze, the LMS switch that chooses between our recorder and LiveKit's (off by default), crash handling, a load-test tool, a server setup kit, **the tail-loss fix** (a crash late in a class no longer loses the end; judged on the whole class), and **the fleet manager** (creates and deletes servers by the timetable, with a hard cap on servers, a 6-hour-style forgotten-server sweep, and a refusal to touch anything not tagged as ours).
- **Also built (2 Oct 2026), all tested but not switched on:**
  - **It follows the real timetable.** The LMS has a read-only endpoint, `/api/recorder/forecast`, that says how many classes will be live over the next 48 hours, built from the same schedule the admin calendar shows: cohort rotations, tutor-moved times, cancellations, postponements, closed days, one-off classes, private lessons, and any class live right now (even an unscheduled one). The fleet manager asks it every pass, so a timetable change reaches the servers by itself; nobody edits anything on the server side. If the LMS can't be reached it falls back to the built-in timetable and says so. A school holiday means no servers; a class moved to the afternoon moves the servers with it.
  - **The LMS finds servers that come and go.** The fleet manager keeps a small list of running servers in the private bucket; the LMS (when `RECORDER_FLEET=1`) picks one with free room, tries up to 3, and falls back to LiveKit recording if none is open. Each server accepts only as many classes as its size can take.
  - **A scheduler server** (about $5/month, always on) that runs the fleet pass every 5 minutes, created with `npm run fleet -- scheduler --apply`. Not created yet on purpose.
- **Still to build, in this order:**
  1. **HTTPS between the LMS and the recorder servers** (today the job request travels over plain HTTP; it carries a listen-only, one-room pass, but encrypting it is the right thing before real use).
  2. **A small admin panel** showing recorder health and estimated cost, and an alert if the scheduler stops.
  3. **The 8-core and 16-core servers through the fleet** (only the 2-core size has been created by the fleet manager so far).
- **Still to test:** a larger server (8 cores; only the 2-core size has been created through the fleet manager so far, and the account may have limits), two classes at once through the fleet, a 90-minute class, screen sharing, and a side-by-side quality check against today's recordings.
- **Before going live:** the pilot on one real class (needs the LMS change merged and deployed; the setting is off by default, so merging changes nothing until it is switched on).
