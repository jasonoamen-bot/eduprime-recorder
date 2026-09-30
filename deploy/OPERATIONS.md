# How class recording works, what it costs, and who looks after it

*A plain-English guide for EasyWay. Status: the recorder itself is built and tested; the automatic switch-on/off described in section 3 is a plan, not built yet.*

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

## 3. How the automatic switch-on/off would work (the plan)
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
- **Built and tested:** the recorder, its connection to LiveKit and Backblaze, the LMS switch that chooses between our recorder and LiveKit's (off by default), crash handling, a load-test tool, and a server setup kit.
- **Still to build:** the automatic create/delete of servers (section 3), a small admin panel showing recorder health and estimated cost, and the LMS fix so the later part of a class that was interrupted is never discarded for being short.
- **Still to test:** on a real server, two classes at once, a 90-minute class, screen sharing, and a side-by-side quality check against today's recordings.
