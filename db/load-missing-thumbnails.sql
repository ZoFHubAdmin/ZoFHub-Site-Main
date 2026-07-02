-- Batch 1 of 1
insert into public.games (slug, title, game_url, thumbnail_url, category, is_working, last_checked)
values
  ('roll-master-3d', 'Roll Master 3D', 'https://y8.com/embed/roll_master_3d', '', 'arcade', true, now()),
  ('slice-it-up-webgl', 'Slice It Up', 'https://y8.com/embed/slice_it_up_webgl', '', 'puzzle', true, now()),
  ('run-clash', 'Run Clash', 'https://y8.com/embed/run_clash', '', 'arcade', true, now()),
  ('zombie-fps-survival-3d', 'Zombie FPS Survival 3D', 'https://y8.com/embed/zombie_fps_survival_3d', '', 'shooting', true, now()),
  ('arrow-out', 'Arrow Out', 'https://y8.com/embed/arrow_out', '', 'puzzle', true, now()),
  ('cube-run', 'Cube Run', 'https://y8.com/embed/cube_run', '', 'arcade', true, now()),
  ('gun-jet-runner', 'Gun Jet Runner', 'https://y8.com/embed/gun_jet_runner', '', 'shooting', true, now()),
  ('criminal-escape-the-cops-3d', 'Criminal Escape The Cops 3D', 'https://y8.com/embed/criminal_escape_the_cops_3d', '', 'action', true, now()),
  ('wick-runner', 'Wick Runner', 'https://y8.com/embed/wick_runner', '', 'arcade', true, now()),
  ('color-rush-runner', 'Color Rush Runner', 'https://y8.com/embed/color_rush_runner', '', 'arcade', true, now()),
  ('grass-cutter-3d', 'Grass Cutter 3D', 'https://y8.com/embed/grass_cutter_3d', '', 'casual', true, now()),
  ('interstellar-legends', 'Interstellar Legends', 'https://y8.com/embed/interstellar_legends', '', 'action', true, now()),
  ('color-jump-webgl', 'Color Jump', 'https://y8.com/embed/color_jump_webgl', '', 'arcade', true, now()),
  ('chrono-x-adventure-of-cyber', 'Chrono X: Adventure Of Cyber', 'https://y8.com/embed/chrono_x_adventure_of_cyber', '', 'adventure', true, now()),
  ('police-escape-3d', 'Police Escape 3D', 'https://y8.com/embed/police_escape_3d', '', 'action', true, now()),
  ('neon-rush-3d', 'Neon Rush 3D', 'https://y8.com/embed/neon_rush_3d', '', 'arcade', true, now()),
  ('car-racing-drift-3d', 'Car Racing Drift 3D', 'https://y8.com/embed/car_racing_drift_3d', '', 'racing', true, now()),
  ('ball-rush-3d', 'Ball Rush 3D', 'https://y8.com/embed/ball_rush_3d', '', 'arcade', true, now()),
  ('happy-farm-webgl', 'Happy Farm', 'https://y8.com/embed/happy_farm_webgl', '', 'simulator', true, now()),
  ('connect-4', 'Connect 4', 'https://y8.com/embed/connect_4', '', 'board', true, now()),
  ('street-rally-2015', 'Street Rally 2015', 'https://y8.com/embed/street_rally_2015', '', 'racing', true, now()),
  ('death-run-3d', 'Death Run 3D', 'https://y8.com/embed/death_run_3d', '', 'arcade', true, now()),
  ('razor-run', 'Razor Run', 'https://y8.com/embed/razor_run', '', 'arcade', true, now()),
  ('furious-ride-webgl', 'Furious Ride', 'https://y8.com/embed/furious_ride_webgl', '', 'racing', true, now()),
  ('slope-y8', 'Slope (Y8)', 'https://y8.com/embed/slope', '', 'arcade', true, now()),
  ('happy-farm-y8', 'Happy Farm (Y8)', 'https://y8.com/embed/happy_farm_webgl', '', 'simulator', true, now()),
  ('ninja-shadow-kunai-y8', 'Ninja Shadow Kunai (Y8)', 'https://y8.com/embed/ninja_shadow_kunai', '', 'action', true, now()),
  ('turbo-racer-3d-y8', 'Turbo Racer 3D (Y8)', 'https://y8.com/embed/turbo_racer_3d', '', 'racing', true, now())
on conflict (slug) do update set
  title = excluded.title,
  game_url = excluded.game_url,
  thumbnail_url = excluded.thumbnail_url,
  category = excluded.category,
  is_working = excluded.is_working,
  last_checked = excluded.last_checked,
  updated_at = now();

select count(*) as total_games from public.games;
