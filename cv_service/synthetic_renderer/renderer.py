import numpy as np
import cv2

# Standard COCO 17-keypoint skeleton connections
SKELETON_EDGES = [
    (15, 13), (13, 11), (16, 14), (14, 12), (11, 12), 
    (5, 11), (6, 12), (5, 6), (5, 7), (6, 8), (7, 9), 
    (8, 10), (1, 2), (0, 1), (0, 2), (1, 3), (2, 4), (3, 5), (4, 6)
]

class SyntheticRenderer:
    def __init__(self, W, H, fps=30):
        self.W = W
        self.H = H
        self.fps = fps
        self.raw_data = [] # Store raw data for every frame to process at the end
        
    def add_frame_data(self, keypoints_list, ids_list, ball_x, ball_y):
        """
        keypoints_list: list of [17, 2] numpy arrays
        ids_list: list of ints
        """
        self.raw_data.append({
            'kpts': keypoints_list,
            'ids': ids_list,
            'bx': ball_x,
            'by': ball_y
        })
        
    def render_video(self, output_path, team_assignments=None, telemetry_events=None):
        if team_assignments is None:
            team_assignments = {}
        if telemetry_events is None:
            telemetry_events = []
        # 1. Re-organize data by player ID
        # player_id -> dict of frame_idx -> [17, 2]
        player_tracks = {}
        ball_x_track = {}
        ball_y_track = {}
        
        for frame_idx, data in enumerate(self.raw_data):
            for i, pid in enumerate(data['ids']):
                if pid not in player_tracks:
                    player_tracks[pid] = {}
                player_tracks[pid][frame_idx] = data['kpts'][i]
            
            if data['bx'] is not None:
                ball_x_track[frame_idx] = data['bx']
                ball_y_track[frame_idx] = data['by']
                
        # 2. Smooth ball trajectory
        total_frames = len(self.raw_data)
        all_frames = list(range(total_frames))
        
        smooth_bx = [None] * total_frames
        smooth_by = [None] * total_frames
        
        if len(ball_x_track) > 0:
            known_frames = sorted(list(ball_x_track.keys()))
            known_x = [ball_x_track[f] for f in known_frames]
            known_y = [ball_y_track[f] for f in known_frames]
            
            # Interpolate missing gaps for the ball
            interp_bx = np.interp(all_frames, known_frames, known_x)
            interp_by = np.interp(all_frames, known_frames, known_y)
            
            # Apply mathematical moving average
            window = 5
            for i in range(total_frames):
                start = max(0, i - window // 2)
                end = min(total_frames, i + window // 2 + 1)
                smooth_bx[i] = np.mean(interp_bx[start:end])
                smooth_by[i] = np.mean(interp_by[start:end])
                
        # 3. Smooth player trajectories
        smooth_player_tracks = {}
        for pid, frames_dict in player_tracks.items():
            smooth_player_tracks[pid] = {}
            known_frames = sorted(list(frames_dict.keys()))
            if len(known_frames) < 3:
                # Too short to track properly, just copy raw
                for f in known_frames:
                    smooth_player_tracks[pid][f] = frames_dict[f]
                continue
                
            first_f = known_frames[0]
            last_f = known_frames[-1]
            active_frames = list(range(first_f, last_f + 1))
            
            kpts_stack = np.array([frames_dict[f] for f in known_frames]) # [N, 17, 2]
            
            # Interpolate all 17 limbs for missing frames (e.g. occlusion behind another player)
            # YOLO returns [0, 0] for occluded joints. We must NOT interpolate through [0, 0]!
            interp_kpts = np.zeros((len(active_frames), 17, 2))
            
            for joint in range(17):
                # Find frames where this specific joint was actually seen
                valid_mask = (kpts_stack[:, joint, 0] != 0.0) | (kpts_stack[:, joint, 1] != 0.0)
                valid_frames = np.array(known_frames)[valid_mask]
                
                if len(valid_frames) == 0:
                    continue
                elif len(valid_frames) == 1:
                    interp_kpts[:, joint, 0] = kpts_stack[valid_mask][0, joint, 0]
                    interp_kpts[:, joint, 1] = kpts_stack[valid_mask][0, joint, 1]
                    continue
                    
                for coord in range(2):
                    valid_values = kpts_stack[valid_mask, joint, coord]
                    interp_kpts[:, joint, coord] = np.interp(
                        active_frames, 
                        valid_frames, 
                        valid_values
                    )
                    
            # Apply mathematical moving average across time dimension for flawless joint movement
            window = 5
            smoothed_kpts = np.zeros_like(interp_kpts)
            for i in range(len(active_frames)):
                start = max(0, i - window // 2)
                end = min(len(active_frames), i + window // 2 + 1)
                smoothed_kpts[i] = np.mean(interp_kpts[start:end], axis=0)
                
            for i, f in enumerate(active_frames):
                smooth_player_tracks[pid][f] = smoothed_kpts[i]
                
        # 4. Render Synthetic Video
        fourcc = cv2.VideoWriter_fourcc(*'avc1')
        out = cv2.VideoWriter(output_path, fourcc, self.fps, (self.W, self.H))
        
        # We will use a pristine green pitch background
        pitch_color = (60, 140, 60) # BGR for dark green
        
        # Determine defending sides based on average X coordinate
        team_avg_x = {0: [], 1: []}
        for pid in smooth_player_tracks:
            team = team_assignments.get(pid)
            if team in [0, 1]:
                all_x = [kpts[0][0] for f, kpts in smooth_player_tracks[pid].items() if kpts[0][0] != 0]
                if all_x:
                    team_avg_x[team].extend(all_x)
                    
        team_0_left = True
        if team_avg_x[0] and team_avg_x[1]:
            if np.mean(team_avg_x[0]) > np.mean(team_avg_x[1]):
                team_0_left = False
                
        # Colors for teams (BGR)
        t0_color = (255, 100, 100) # Blue
        t1_color = (100, 100, 255) # Red
        gk_color = (0, 255, 255)   # Yellow (Goalkeeper/Referee)
        
        # Keep track of kicks to log offside violations
        kick_frames = set([e["frame"] for e in telemetry_events if e["event"] == "BALL_KICKED"])
        
        for frame_idx in range(total_frames):
            frame = np.full((self.H, self.W, 3), pitch_color, dtype=np.uint8)
            
            # 1. Calculate Offside Lines & Goal Lines for this frame
            t0_xs = []
            t1_xs = []
            player_positions = [] # Store (pid, team, x) to check violations
            
            left_goal_x = None
            right_goal_x = None
            
            for pid in smooth_player_tracks:
                if frame_idx in smooth_player_tracks[pid]:
                    kpts = smooth_player_tracks[pid][frame_idx]
                    head_x = kpts[0][0]
                    if head_x != 0:
                        team = team_assignments.get(pid, -1)
                        if team == 0: t0_xs.append(head_x)
                        elif team == 1: t1_xs.append(head_x)
                        elif team == -1:
                            # Use Goalkeeper to establish physical Goal Lines!
                            if head_x < self.W / 3:
                                left_goal_x = max(0, head_x - 30)
                            elif head_x > 2 * self.W / 3:
                                right_goal_x = min(self.W, head_x + 30)
                                
                        player_positions.append({'pid': pid, 'team': team, 'x': head_x})
                        
            # Draw Dynamic Physical Goal Lines
            if left_goal_x is not None:
                cv2.line(frame, (int(left_goal_x), 0), (int(left_goal_x), self.H), (255, 255, 255), 8)
                cv2.putText(frame, "GOAL LINE", (int(left_goal_x) + 10, 50), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)
            if right_goal_x is not None:
                cv2.line(frame, (int(right_goal_x), 0), (int(right_goal_x), self.H), (255, 255, 255), 8)
                cv2.putText(frame, "GOAL LINE", (int(right_goal_x) - 130, 50), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)
                
            # Offside Line for Team 0 (defending Left or Right)
            t0_offside_x = None
            if len(t0_xs) >= 2:
                t0_xs.sort()
                t0_offside_x = t0_xs[1] if team_0_left else t0_xs[-2]
                
            t1_offside_x = None
            if len(t1_xs) >= 2:
                t1_xs.sort()
                t1_offside_x = t1_xs[1] if not team_0_left else t1_xs[-2]
                
            # Draw Offside Lines
            if t0_offside_x is not None:
                cv2.line(frame, (int(t0_offside_x), 0), (int(t0_offside_x), self.H), t0_color, 2)
            if t1_offside_x is not None:
                cv2.line(frame, (int(t1_offside_x), 0), (int(t1_offside_x), self.H), t1_color, 2)
                
            # Check Offside Violations at the exact moment of a kick
            if frame_idx in kick_frames:
                for p in player_positions:
                    if p['team'] == 1 and t0_offside_x is not None:
                        # Team 1 attacking Team 0
                        if (team_0_left and p['x'] < t0_offside_x) or (not team_0_left and p['x'] > t0_offside_x):
                            telemetry_events.append({"frame": frame_idx, "event": "OFFSIDE_VIOLATION", "offender_id": p['pid']})
                    elif p['team'] == 0 and t1_offside_x is not None:
                        # Team 0 attacking Team 1
                        if (not team_0_left and p['x'] < t1_offside_x) or (team_0_left and p['x'] > t1_offside_x):
                            telemetry_events.append({"frame": frame_idx, "event": "OFFSIDE_VIOLATION", "offender_id": p['pid']})
                            
            # 2. Draw perfectly smooth players
            for pid in smooth_player_tracks:
                if frame_idx in smooth_player_tracks[pid]:
                    kpts = smooth_player_tracks[pid][frame_idx]
                    team = team_assignments.get(pid, -1)
                    
                    if team == 0: bone_color = t0_color
                    elif team == 1: bone_color = t1_color
                    elif team == -1: bone_color = gk_color
                    else: bone_color = (255, 255, 255)
                    
                    # Draw thick anti-aliased bones
                    for edge in SKELETON_EDGES:
                        p1 = kpts[edge[0]]
                        p2 = kpts[edge[1]]
                        
                        # Only draw if not [0,0] (invalid)
                        if p1[0] != 0 and p2[0] != 0:
                            pt1 = (int(p1[0]), int(p1[1]))
                            pt2 = (int(p2[0]), int(p2[1]))
                            
                            # Clean anti-aliased lines for player limbs
                            cv2.line(frame, pt1, pt2, bone_color, 4, cv2.LINE_AA)
                            
                    # Draw head as a slightly larger circle
                    head_x, head_y = kpts[0]
                    if head_x != 0:
                        cv2.circle(frame, (int(head_x), int(head_y)), 10, bone_color, -1, cv2.LINE_AA)
                        
            # 3. Draw mathematically smoothed ball trajectory
            if smooth_bx[frame_idx] is not None:
                bx = int(smooth_bx[frame_idx])
                by = int(smooth_by[frame_idx])
                # Draw a highly visible geometric yellow ball
                cv2.circle(frame, (bx, by), 12, (0, 255, 255), -1, cv2.LINE_AA)
                cv2.circle(frame, (bx, by), 12, (0, 0, 0), 2, cv2.LINE_AA)
                
            out.write(frame)
            
        out.release()
