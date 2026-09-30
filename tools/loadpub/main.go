// loadpub: a LIGHTWEIGHT fake tutor for testing the recorder.
//
// The Chromium-based fake tutor used in earlier tests costs 1-2 CPU cores of its own, which on one
// laptop starves the recorder being measured. This publishes PRE-ENCODED VP8 video + Opus audio read
// from files straight into a LiveKit room — no browser, no encoding — so it uses almost no CPU, and
// many "classes" can run at once.
//
//	loadpub --url wss://... --token <jwt> --video media/video.ivf --audio media/audio.ogg --seconds 300
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"sync"
	"time"

	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/livekit/protocol/livekit"
)

func main() {
	url := flag.String("url", "", "LiveKit websocket URL")
	token := flag.String("token", "", "participant token (with canPublish)")
	videoFile := flag.String("video", "media/video.ivf", "VP8 .ivf file")
	audioFile := flag.String("audio", "media/audio.ogg", "Opus .ogg file")
	seconds := flag.Int("seconds", 300, "how long to stay in the room")
	flag.Parse()
	if *url == "" || *token == "" {
		fmt.Fprintln(os.Stderr, "--url and --token are required")
		os.Exit(2)
	}

	// Connecting from a busy laptop over a congested network can take longer than the SDK's 5 s default and
	// fails now and then: give it 25 s per try and up to 6 tries, like any real client would.
	var room *lksdk.Room
	var err error
	for attempt := 1; attempt <= 6; attempt++ {
		room, err = lksdk.ConnectToRoomWithToken(*url, *token, &lksdk.RoomCallback{},
			lksdk.WithAutoSubscribe(false), lksdk.WithConnectTimeout(25*time.Second))
		if err == nil {
			break
		}
		fmt.Fprintf(os.Stderr, "connect attempt %d failed: %v\n", attempt, err)
		time.Sleep(time.Duration(attempt) * 2 * time.Second)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "connect failed:", err)
		os.Exit(1)
	}
	defer room.Disconnect()

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(*seconds)*time.Second)
	defer cancel()
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt)
	go func() { <-sig; cancel() }()

	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); loopTrack(ctx, room, *videoFile, livekit.TrackSource_CAMERA, "camera") }()
	go func() { defer wg.Done(); loopTrack(ctx, room, *audioFile, livekit.TrackSource_MICROPHONE, "microphone") }()
	fmt.Println("loadpub: publishing for", *seconds, "s")
	<-ctx.Done()
	wg.Wait()
	fmt.Println("loadpub: left the room")
}

// loopTrack publishes the file, and when it runs out publishes it again, until the context ends.
func loopTrack(ctx context.Context, room *lksdk.Room, file string, source livekit.TrackSource, name string) {
	for ctx.Err() == nil {
		done := make(chan struct{})
		track, err := lksdk.NewLocalFileTrack(file, lksdk.ReaderTrackWithOnWriteComplete(func() { close(done) }))
		if err != nil {
			fmt.Fprintln(os.Stderr, name, "track:", err)
			return
		}
		pub, err := room.LocalParticipant.PublishTrack(track, &lksdk.TrackPublicationOptions{Name: name, Source: source})
		if err != nil {
			fmt.Fprintln(os.Stderr, name, "publish:", err)
			return
		}
		select {
		case <-done:
			_ = room.LocalParticipant.UnpublishTrack(pub.SID())
		case <-ctx.Done():
			return
		}
	}
}
