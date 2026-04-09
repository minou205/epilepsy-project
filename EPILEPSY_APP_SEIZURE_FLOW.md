# Epilepsy App: Complete Backend Flow for First 5 Seizures

## Overview
When a user reports/collects seizures in the app, the backend doesn't immediately train personal models. Instead, it **accumulates real seizure data** and triggers **automated incremental training** when specific thresholds are reached. Here's the complete flow:

---

## PHASE 1: Seizures 1-4 (Data Collection & Queuing)

### What App Does (Frontend - React Native/Expo)

**User Action**: User presses "I had a seizure" button on TrackerScreen

**Frontend Flow**:
1. **EEG Data Capture** (from `DataCollector.ts`)
   - App has been continuously collecting EEG data in a **21-minute circular buffer** (LONG_BUFFER_SECS)
   - When user reports seizure, app calls `collectSeizureData()` which:
     - Retrieves last 21 minutes from the circular buffer (or whatever is available)
     - **Splits into TWO files**:
       - **Preictal file** (20 min if >2 min total, else everything before ictal)
       - **Ictal file** (last 1 min if >2 min total, else all data)
     - Saves both as `.csv` files locally (app phone storage)
     - Each channel gets own row: `timestamp_ms,channel,sample_index,label,amplitude_uV`
     - Data format: [18 channels] × [256 Hz] × [1280 samples/5 sec]

2. **Data Upload** (BackendClient.ts)
   - Frontend calls `uploadSeizureData(seizeDataPackage)`
   - FormData sends:
     - `patient_id`: user's Supabase ID
     - `seizure_id`: unique timestamp-based ID
     - `captured_at`: ISO timestamp
     - `channel_names`: JSON array (e.g., ['FP1-F7', 'F7-T7', ...])
     - `sampling_rate`: 256 Hz
     - `preictal_file`: multipart file (~1.3MB for 20min × 18ch)
     - `ictal_file`: multipart file (~65KB for 1min × 18ch)

### What Backend Does (Python FastAPI)

**Endpoint**: `POST /data/seizure` (in `routers/data_upload.py`)

**Step 1: Headset Validation**
```
→ _validate_headset() checks:
  - Parse channel_names JSON
  - Verify channels match patient's registered headset (stored in DB)
  - If mismatch → return 409 error with details (used to show 
    "Did you change your headset?" modal in app)
```

**Step 2: File Storage**
```
→ Files saved to: storage/eeg_data/{patient_id}/
  - preictal_{seizure_id}.csv
  - ictal_{seizure_id}.csv
→ Both files contain formatted EEG samples ready for ML training
```

**Step 3: Database Record**
```python
# Create SeizureEvent record
event = SeizureEvent(
    seizure_id    = seizure_id,
    patient_id    = patient_id,
    captured_at   = captured_at,
    preictal_file = str(preictal_dest),  # Path to .csv
    ictal_file    = str(ictal_dest),      # Path to .csv
    channel_names = channel_names,        # JSON string
    sampling_rate = 256,
    uploaded_at   = _now(),
)
db.add(event)
await db.commit()
```

**Step 4: Training Trigger Decision**
```python
# Count total confirmed seizures for this patient
count_result = SELECT COUNT(*) FROM seizure_events WHERE patient_id = ?
seizure_count = count_result  # e.g., 1, 2, 3, or 4

# Training constants:
SEIZURES_PER_TRAINING = 5   # Trigger at seizure 5, 10, 15, etc.
MAX_SEIZURES = 50           # Stop after 50 seizures

# For seizures 1-4:
if (seizure_count == 1, 2, 3, or 4):
    → NOT a multiple of 5
    → training_queued = False
    → Return to app:
       {
         "seizure_count": 1-4,
         "training_queued": false,
         "max_reached": false,
         "ask_satisfaction": false,
         "next_train_at": 5
       }

# App UI shows: "Seizures recorded: 1/5 for first model"
```

### For Seizures 1-4: Summary
- ✅ Data **stored safely** on disk
- ✅ Database record **created** (SeizureEvent table)
- ✅ No training triggered yet
- ✅ App shows progress counter: "1/5", "2/5", etc.

---

## PHASE 2: Seizure 5 (TRAINING TRIGGER)

### Backend Decision Point

**Same Upload Endpoint**, but now:
```python
seizure_count = 5  # Just committed the 5th seizure

if (seizure_count > 0 
    and seizure_count % SEIZURES_PER_TRAINING == 0 
    and not max_reached):
    
    version_num = seizure_count // SEIZURES_PER_TRAINING  # 5 // 5 = 1
    tier = f"v{version_num}"                              # "v1"
    
    # QUEUE BACKGROUND TRAINING JOB
    background_tasks.add_task(enqueue_training, 
                             db, patient_id, tier, 1)
    training_queued = True

return {
    "seizure_count": 5,
    "training_queued": True,        # ← KEY CHANGE
    "max_reached": False,
    "ask_satisfaction": True,       # Also ask how satisfied they are
    "next_train_at": 10
}
```

### Training Job Queued
```
In training_service.py:
  enqueue_training() creates TrainingJob record:
  
  job = TrainingJob(
    job_id = UUID,
    patient_id = patient_id,
    tier = "v1",
    version_num = 1,
    status = "queued"  # ← Not running yet
  )
  
  # Launch background thread
  thread = threading.Thread(
    target=_run_training_sync,
    args=(job_id, patient_id, "v1", 1),
    daemon=True
  )
  thread.start()
```

### Frontend Response
```
App receives:
{
  "seizure_count": 5,
  "training_queued": true,
  "ask_satisfaction": true
}

App shows:
  - Celebrates "Model training started!" message
  - Shows satisfaction survey modal
  - Begins polling /training/status endpoint every 5 seconds
```

---

## PHASE 3: Model Training (Background Thread)

### Training Job Lifecycle

**Status Progression**:
```
queued → running → complete → (or failed)
```

### Step 1: Collect Training Data

Training function in `personal_prediction.py` and `personal_detection.py`:

```python
train_predictor(patient_id, patient_data_dir, chb_mit_dir, 
                output_dir, tier="v1")
```

**Data Discovery** - Scans patient's EEG directory:
```
storage/eeg_data/{patient_id}/
├── preictal_seizure1.csv      # 20 min preictal before seizure 1
├── ictal_seizure1.csv         # 1 min ictal during seizure 1
├── preictal_seizure2.csv
├── ictal_seizure2.csv
├── preictal_seizure3.csv
├── ictal_seizure3.csv
├── preictal_seizure4.csv
├── ictal_seizure4.csv
├── preictal_seizure5.csv
├── ictal_seizure5.csv
├── normal_*.csv               # Optional inter-ictal background data
└── false_positives/
    └── false_positive_*.csv   # User-marked non-seizures (to reduce FPR)
```

### Step 2: Load & Preprocess Data

```python
# Load all seizure clips
preictal_files = glob("preictal_*.csv")  # 5 files
ictal_files = glob("ictal_*.csv")        # 5 files
normal_files = glob("normal_*.csv")      # Maybe 0-N files

# For each CSV file:
for fp in preictal_files:
    data = np.loadtxt(fp, delimiter=',', skiprows=1)  # [samples, 18 channels]
    
    # Reshape into 5-second clips @ 256 Hz:
    # CLEN = 256 * 5 = 1280 samples per clip
    # Each 20-min preictal = 240 clips
    # Each 1-min ictal = 12 clips
    
    clips = reshape_to_clips(data, CLEN=1280)  # [n_clips, 18, 1280]
    preictal_clips.append(clips)

# Result:
preictal_clips    = [num_clips, 18, 1280]    # e.g., [1200, 18, 1280]
normal_clips      = [num_clips, 18, 1280]    # e.g., [600, 18, 1280]
```

**Signal Processing**:
```python
# Apply butterworth bandpass filter (0.5-50 Hz)
data = apply_clep_filter(data, sfreq=256)

# Global z-score normalization (using first 5 min as reference)
data_norm, mu, std = global_zscore(data, fit_minutes=5)
# Stores: mu, std for later use during inference
```

### Step 3: Train/Val Split

```python
# 80/20 split
split = 0.8
train_pre, val_pre = preictal_clips[:split], preictal_clips[split:]
train_int, val_int = normal_clips[:split], normal_clips[split:]

# Create labels
train_labels = [1]*len(train_pre) + [0]*len(train_int)  # 1=preictal, 0=normal
val_labels   = [1]*len(val_pre)   + [0]*len(val_int)

# Datasets
train_dataset = EEGDataset(train_clips, train_labels)
val_dataset   = EEGDataset(val_clips,   val_labels)
```

### Step 4: Model Architecture & Training

**Model: HybridSTSNet** (Deep spatia-temporal network)
```
Input: [batch, 18 channels, 1280 samples]
  ↓
PyramidConvNet (multi-scale freq extraction)
  ↓
TripleAttentionFusionNet (attention-based fusion)
  ↓
SpatioDynamicGCN (spatial graph convolution on 3D head positions)
  ↓
MSTemporalBridge (multi-scale temporal pooling)
  ↓
FC layers → [batch, 2] logits (normal vs. preictal/ictal)
```

**Training Stages**:

1. **Pretraining (if CHB-MIT dataset available)**
   ```python
   # Use open-source seizure data from CHB-MIT database
   # to initialize network weights
   
   for epoch in range(PRETRAIN_EPOCHS=50):
       # Contrastive learning on source patients (CHB-MIT)
       loss = pretrain_clep(encoder, source_datasets, ...)
   ```

2. **Identify Hard Negatives**
   ```python
   # Find "normal" clips that look most like preictal
   # These are hard to distinguish → prioritize in training
   
   hard_int_idxs = find_hard_interictal(
       encoder, train_int, 
       THRESHOLD_W=0.6
   )
   ```

3. **Finetune with Adversarial Augmentation**
   ```python
   # Augment training data:
   # - Add Gaussian noise (std=0.05 uV)
   # - Randomly drop channels (10% dropout)
   
   aug_dataset = EEGAugDataset(
       train_clips, train_labels,
       noise_std=0.05, ch_drop_p=0.10
   )
   
   for epoch in range(FINETUNE_EPOCHS=60):
       # Focal loss + contrastive loss (hard negatives weighted higher)
       loss = finetune_best(encoder, aug_dataset, ...)
   ```

4. **Calibration Threshold**
   ```python
   # Find optimal decision threshold (Youden-J statistic)
   # Using validation set
   
   calib_thresh = calibrate_threshold(encoder, val_dataset)
   # e.g., calib_thresh = 0.65 (if prob > 0.65 → "preictal")
   ```

5. **Adversarial Discriminator Training**
   ```python
   # WGAN discriminator learns to distinguish:
   # - Real preictal feature sequences
   # - Real interical feature sequences
   # - Ensures model extracts discriminative features
   
   disc = SequenceWGANDiscriminator(
       feature_dim=256, 
       seq_len=3
   )
   
   for epoch in range(WGAN_EPOCHS=100):
       # Wasserstein loss + gradient penalty
       disc_loss = train_discriminator_wgan(
           encoder, disc, train_dataset, 
           lr=4e-5, lambda_gp=10.0
       )
   ```

### Step 5: Model Export & Save

```python
# Save trained model
pt_path = save_patient_brain(
    encoder, disc, patient_id,
    disc_calibration=disc_cal,
    calib_thresh=0.65,
    train_ref_mu=μ,      # mean for z-score
    train_ref_std=σ,     # std for z-score
    folder=f"storage/models/patients/{patient_id}"
)

# Saves to:
# storage/models/patients/{patient_id}/v1_predictor.pt
# Weight: ~5-10 MB (PyTorch checkpoint with metadata)

# Checkpoint structure:
{
    'state_dict': encoder.state_dict(),
    'disc_state_dict': disc.state_dict(),
    'calib_thresh': 0.65,      # Used during inference
    'train_ref_mu': 12.5,       # Used for normalization
    'train_ref_std': 34.2,      # Used for normalization
    'n_channels': 18,
    'channel_names': ['FP1-F7', 'F7-T7', ...],
}
```

### Step 6: Database Update

```python
# Update training job status
job.status = 'complete'
job.completed_at = _now()
db.commit()

# Create ModelArtifact records
artifact_pred = ModelArtifact(
    id = UUID,
    patient_id = patient_id,
    tier = "v1",
    version_num = 1,
    model_type = "predictor",
    file_path = "storage/models/patients/{patient_id}/v1_predictor.pt",
    created_at = _now(),
    is_active = 1  # ← ACTIVE
)

artifact_det = ModelArtifact(
    id = UUID,
    patient_id = patient_id,
    tier = "v1",
    version_num = 1,
    model_type = "detector",
    file_path = "storage/models/patients/{patient_id}/v1_detector.pt",
    created_at = _now(),
    is_active = 1
)

db.add(artifact_pred)
db.add(artifact_det)

# Deactivate any previous general/v0 artifacts
for old_artifact in db.query(ModelArtifact).filter_by(
    patient_id=patient_id, is_active=1
):
    old_artifact.is_active = 0  # Mark as superseded

db.commit()

# Invalidate inference cache
model_cache.invalidate(patient_id)
```

### Training Timeline
```
Time                 Job Status              What's Happening
─────────────────────────────────────────────────────────────
Seizure 5 uploaded   queued [0s]             Background thread starting
                     running [2s]            Loading CHB-MIT + user data
                     running [10s]           Pretraining (50 epochs)
                     running [45s]           Finetuning (60 epochs)
                     running [90s]           WGAN discriminator (100 epochs)
                     running [120s]          Model export
                     complete [125s]         Database updated
```

**Total Time**: ~2-3 minutes on typical hardware (CPU: 5-10 min, GPU: 2-3 min)

---

## PHASE 4: Inference with Personal Model

### Frontend: Polling for Training Status

```typescript
// App polls every 5 seconds
const pollTrainingStatus = () => {
  const status = await backendClient.getTrainingStatus(patientId);
  // {
  //   status: 'running' | 'complete' | 'failed',
  //   progressPct: 0 or 100,
  //   tier: 'v1',
  //   started_at: ISO,
  //   completed_at: ISO,
  //   error_msg: null
  // }
  
  if (status.status === 'complete') {
    showModal("✅ First personal model trained!");
    stopPolling();
  }
}
```

### Backend: Serving Trained Model

**Endpoint**: `POST /inference/run`

**Frontend sends**: 
```json
{
  "patient_id": "user-uuid",
  "eeg_data": [[...], [...], ...],  // [18][1280] EEG window
  "general_model_config": "both",    // Use personal if available
  "sampling_rate": 256
}
```

**Backend Inference Flow**:

1. **Model Discovery** (from `inference_service.py`)
   ```python
   # Query for active personal models, ordered by version
   result = db.query(ModelArtifact).filter(
       patient_id == patient_id,
       is_active == 1
   ).order_by(version_num DESC)
   
   artifacts = result.all()  # [(v1_predictor, v1_detector), ...]
   
   # Use highest version (v1 now)
   tier = "v1"
   personal_predictor = artifact[0]  # v1_predictor.pt
   personal_detector = artifact[1]   # v1_detector.pt
   ```

2. **Load Model** (lazy-loaded into cache)
   ```python
   model_cache.get_or_load(
       key="patient_id_predictor",
       model_path=Path("storage/models/patients/patient_id/v1_predictor.pt"),
       model_type="predictor"
   )
   
   # First call: loads from disk
   # Subsequent calls: uses cached model
   # Cache invalidates when new model trained
   ```

3. **Run Inference**
   ```python
   # Prepare data
   data_np = np.array(eeg_data)  # [18, 1280]
   
   # Z-score normalize using training stats
   mu = entry['train_ref_mu']     # 12.5
   std = entry['train_ref_std']   # 34.2
   normalized = (data_np - mu) / (std + 1e-8)
   
   # Forward pass
   tensor = torch.from_numpy(normalized).float().unsqueeze(0)  # [1, 18, 1280]
   
   with torch.no_grad():
       logits = model(tensor)  # [1, 2]
   
   # Get probability
   probs = torch.softmax(logits, dim=1)
   prob = probs[0, 1].item()  # Probability of positive class
   
   # Apply calibrated threshold
   thresh = entry['calib_thresh']  # 0.65
   label = 'preictal' if prob >= thresh else 'normal'
   ```

**Backend Response**:
```json
{
  "predictor_prob": 0.78,
  "detector_prob": 0.12,
  "predictor_label": "preictal",
  "detector_label": "normal",
  "tier": "v1",
  "has_predictor": true,
  "has_detector": true
}
```

### Frontend: Alarm Triggering

```typescript
// Receive inference result
if (result.predictor_label === 'preictal' && result.predictor_prob > 0.7) {
  // Trigger alarm 15 minutes before expected seizure
  showAlarmModal("Seizure predicted in ~15 minutes");
  playNotificationSound();
  
  if (hasHelper) {
    await backendClient.sendHelperAlarm(patientId, 'prediction');
  }
}

if (result.detector_label === 'ictal') {
  // Immediate detection
  showAlarmModal("Seizure detected NOW");
  playUrgentSound();
  
  if (hasHelper) {
    await backendClient.sendHelperAlarm(patientId, 'detection');
  }
}
```

---

## PHASE 5: False Positives & Model Refinement

### When Alarm Fires But No Seizure Happens

**User Action**: Press "No seizure" in the modal

**Frontend**:
```
collectFalsePositiveData()
→ backendClient.uploadFalsePositive({
    fp_id: UUID,
    alarm_id: alarm_id,
    alarm_type: 'prediction',
    model_tier: 'v1',
    captured_at: ISO,
    eeg_file: [...the 5-sec EEG that triggered false alarm]
  })
```

**Backend** (`POST /data/false_positive`):
```
storage/eeg_data/{patient_id}/false_positives/
  └── false_positive_{fp_id}.csv

Stored FalsePositiveEvent in database:
  - Links to the alarm that triggered it
  - Saved for next training cycle
```

### On Next Training (Seizure 10)

```python
# When training_predictor() runs for v2:
normal_files = glob("normal_*.csv")
fp_files = glob("false_positives/false_positive_*.csv")

# Combine into "normal" training data
extra_normal_data = load(normal_files + fp_files)

# Training now includes these "proven false alarms"
# → Model learns to NOT trigger on these patterns
# → False Positive Rate (FPR) decreases over time
```

---

## PHASE 6: Seizures 6-10 (Incremental Learning)

### Seizures 6-9
- Same flow as 1-4
- Data accumulates
- No training triggered

### Seizure 10
- **TRIGGERS TRAINING AGAIN**
- Creates `TrainingJob` with:
  ```
  tier = "v2"
  version_num = 2
  ```

**Training Dataset Now Includes**:
- All 10 seizures (200 preictal clips + 120 ictal clips from patient)
- All false positives accumulated since v1
- CHB-MIT pretraining

**Key Differences from v1**:
```
v1 used:    5 seizures
v2 uses:    10 seizures +  false positive feedback
v3 uses:    15 seizures +  false positive feedback
...
vN uses:    5N seizures +  all accumulated feedback
```

---

## Key Technical Details

### Model Versions Architecture
```
storage/models/patients/{patient_id}/
├── predictor.pt      ← Currently active (symlink to v1 or v2)
├── detector.pt
├── v1_predictor.pt   ← Trained on 5 seizures
├── v1_detector.pt
├── v2_predictor.pt   ← Trained on 10 seizures
├── v2_detector.pt
├── v3_predictor.pt   ← Trained on 15 seizures
└── v3_detector.pt
```

### Model Artifact Lifecycle
```
When v1 completes:
  - ModelArtifact: (v1_predictor, is_active=1)
  - Previous artifacts: (general_predictor, is_active=0)  ← Deactivated

When v2 completes:
  - ModelArtifact: (v2_predictor, is_active=1)
  - Previous: (v1_predictor, is_active=0)
  - All archived versions stay on disk for audit/rollback
```

### Inference Model Selection
```
Priority order:
1. Active personal trained model (highest version)   ← v1 used after seizure 5
2. Patient's copy of general model
3. Shared general baseline model
4. No models → all probabilities = None
```

### Data Validation & Headset Locking
```
When seizure 1 uploaded:
  - Channel names registered: ['FP1-F7', 'F7-T7', ...]
  - Headset locked to these channels

For seizures 2-5:
  - Each upload checked against locked channels
  - If different → 409 error (headset mismatch)
  - Helps detect device replacement or errors
```

---

## Summary Timeline

```
Timeline          Event                           Data State
──────────────────────────────────────────────────────────────
User starts app   EEG streaming begins            Circular buffer: 21 min
User has seizure  Presses "I had seizure"         

Seizure #1        Upload preictal + ictal        DB: seizure_events = 1
uploaded          Files: storage/.../preictal_1.csv
                  Status: waiting for more...

Seizure #2        Same as #1                      DB: seizure_events = 2
uploaded          Files: preictal_2.csv, etc.    No training yet

Seizure #3        Same as #1                      DB: seizure_events = 3

Seizure #4        Same as #1                      DB: seizure_events = 4

Seizure #5        TRAINING TRIGGERED!             DB: seizure_events = 5
uploaded          Job queued: v1_predictor        TrainingJob: status=queued
                  TrainingJob: v1, version=1

[2-3 min]         Background training            Job: status=running
                  Load 5 seizures + pretraining,
                  finetune, WGAN disc, export

Training done     v1_predictor.pt saved          ModelArtifact: v1, active=1
                  ModelArtifact: v1, active=1    Inference cache invalidated
                  General models deactivated

Next inference    Uses v1_predictor.pt           Response: tier="v1"
call              Better personal accuracy

Seizures 6-10     Data accumulates               DB: seizure_events = 10

Seizure #10       TRAINING v2 TRIGGERED          TrainingJob: v2, version=2
uploaded          Uses 10 seizures + FP data     v2_predictor.pt created

[2-3 min]         v2 training running            Includes false positives
                                                 → Lower FPR

v2 ready          v1 artifacts: is_active=0      Inference switches to v2
                  v2 artifacts: is_active=1

Next inference    Uses v2_predictor.pt           Response: tier="v2"
call              10x more training data         Better accuracy

...continues...   Max at seizure 50              MAX_SEIZURES limit reached
                  No more training triggered
```

---

## Important Constants & Configuration

```python
# In config.py
SEIZURES_PER_TRAINING = 5       # Trigger at: 5, 10, 15, 20, ...
MAX_SEIZURES = 50               # Stop at 50 total seizures

# In personal_prediction.py/personal_detection.py
PRETRAIN_EPOCHS = 50            # Epochs on CHB-MIT data
FINETUNE_EPOCHS = 60            # Epochs on patient data
WGAN_EPOCHS = 100               # Adversarialtraining
PREICTAL_MIN = 15               # Min preictal window (min)
THRESHOLD_W = 0.6               # Hard negative percentile
WGAN_LR = 4e-5                  # Learning rate
CLEN = 1280                     # Samples per 5-sec clip (256*5)
N_CH = 18                       # Channels
FS = 256                        # Sampling frequency (Hz)
```

---

## Database Tables Involved

### 1. SeizureEvent
```sql
UPDATE seizure_events 
SET patient_id, captured_at, preictal_file, ictal_file, 
    channel_names, sampling_rate, uploaded_at
```

### 2. TrainingJob
```sql
INSERT training_jobs (job_id, patient_id, tier, version_num, status, ...)
UPDATE training_jobs SET status='running' THEN status='complete'
```

### 3. ModelArtifact
```sql
INSERT model_artifacts (id, patient_id, tier, version_num, 
                        model_type, file_path, is_active)
UPDATE model_artifacts SET is_active=0  -- Deactivate old versions
```

### 4. PatientHeadset
```sql
SELECT * FROM patient_headset WHERE patient_id=?
-- Validates channel names match registered headset
```

---

## Error Handling

### Headset Mismatch
```
409 Conflict
{
  "error": "headset_mismatch",
  "expected": ["FP1-F7", "F7-T7", ...],
  "got": ["FP1-F7", "F7-T7", ..., "EX-TRY"],  // Different!
  "message": "Uploaded channels differ from registered headset."
}
```

### Insufficient Data for Training
```
ValueError: Not enough preictal data for patient_id: 3 clips
(Requires minimum 2 clips of training data)
```

### Training Failure
```
TrainingJob: status='failed'
error_msg='Could not load CHB-MIT data' or similar
→ App shows error, data still safe for manual retry
```

---

## Privacy & Data Flow

### Supabase Integration
- Patient credentials stored in Supabase Auth
- ModelArtifact records stored in Supabase DB
- EEG files stored locally on backend (not in Supabase)

### Local Storage
```
Backend:      storage/eeg_data/{patient_id}/...
              storage/models/patients/{patient_id}/...
Frontend:     {AppDocuments}/eeg_data/...
Database:     sqlite ehss.db + Supabase
```

### No Cloud EEG Upload
- EEG data **never leaves the backend**
- Only **metadata** synced to Supabase (patient info, model versions)
- Models trained & stored locally

---

This completes the full journey of the first 5 seizures → personal model training → inference integration.
