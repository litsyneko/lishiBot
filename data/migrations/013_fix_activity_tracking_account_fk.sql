CREATE OR REPLACE FUNCTION record_activity(
  p_user_id TEXT,
  p_track_date TEXT,
  p_reward_per INTEGER,
  p_max_rewards INTEGER
) RETURNS INTEGER
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
DECLARE
  track_record RECORD;
  new_reward_count INTEGER;
BEGIN
  INSERT INTO accounts (user_id, balance, attendance_date)
  VALUES (p_user_id, 0, NULL)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT * INTO track_record FROM activity_tracking
  WHERE user_id = p_user_id AND track_date = p_track_date
  FOR UPDATE;

  IF track_record IS NULL THEN
    INSERT INTO activity_tracking (user_id, track_date, message_count, reward_count)
    VALUES (p_user_id, p_track_date, 1, 0);
    RETURN 0;
  END IF;

  IF track_record.reward_count >= p_max_rewards THEN
    UPDATE activity_tracking SET message_count = activity_tracking.message_count + 1
    WHERE user_id = p_user_id AND track_date = p_track_date;
    RETURN 0;
  END IF;

  new_reward_count := track_record.reward_count + 1;
  UPDATE activity_tracking SET
    message_count = activity_tracking.message_count + 1,
    reward_count = new_reward_count
  WHERE user_id = p_user_id AND track_date = p_track_date;

  PERFORM add_balance(p_user_id, p_reward_per);
  RETURN p_reward_per;
END;
$$;
