package br.com.peragym;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Private, device-local SQLite store. No network or account is involved. */
public final class GymDatabase extends SQLiteOpenHelper {
    public static final String DATABASE_NAME = "peragym.db";
    private static final int DATABASE_VERSION = 1;
    private static final Pattern FIRST_REPETITIONS = Pattern.compile("^\\s*(\\d{1,4})");

    public GymDatabase(Context context) { this(context, DATABASE_NAME); }
    GymDatabase(Context context, String name) { super(context.getApplicationContext(), name, null, DATABASE_VERSION); }

    @Override public void onConfigure(SQLiteDatabase db) { db.setForeignKeyConstraintsEnabled(true); }

    @Override public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE workouts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, focus TEXT NOT NULL DEFAULT '', days TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
        db.execSQL("CREATE TABLE exercises (id INTEGER PRIMARY KEY AUTOINCREMENT, workout_id INTEGER NOT NULL REFERENCES workouts(id) ON DELETE CASCADE, name TEXT NOT NULL, sets INTEGER NOT NULL CHECK(sets BETWEEN 1 AND 100), reps TEXT NOT NULL, weight REAL NOT NULL CHECK(weight >= 0 AND weight <= 2000), rest INTEGER NOT NULL CHECK(rest BETWEEN 0 AND 3600), notes TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL)");
        db.execSQL("CREATE INDEX exercises_workout_position ON exercises(workout_id, position)");
        db.execSQL("CREATE TABLE sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, workout_id INTEGER REFERENCES workouts(id) ON DELETE SET NULL, workout_name TEXT NOT NULL, completed_at INTEGER NOT NULL, volume REAL NOT NULL, duration INTEGER NOT NULL)");
        db.execSQL("CREATE INDEX sessions_completed_at ON sessions(completed_at DESC)");
    }

    @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        // Version 1 is the first schema. Future upgrades must migrate, never erase user data.
        throw new IllegalStateException("Versão do banco de dados não suportada: " + oldVersion + " → " + newVersion);
    }

    public synchronized JSONObject loadData() throws JSONException {
        SQLiteDatabase db = getReadableDatabase();
        db.beginTransaction();
        try {
            JSONArray workouts = new JSONArray();
            try (Cursor w = db.query("workouts", null, null, null, null, null, "id ASC")) {
                while (w.moveToNext()) {
                    long id = number(w, "id");
                    JSONObject workout = new JSONObject().put("id", id).put("name", string(w, "name"))
                            .put("focus", string(w, "focus")).put("days", string(w, "days")).put("notes", string(w, "notes"));
                    JSONArray exercises = new JSONArray();
                    try (Cursor e = db.query("exercises", null, "workout_id=?", new String[]{Long.toString(id)}, null, null, "position ASC,id ASC")) {
                        while (e.moveToNext()) exercises.put(new JSONObject().put("id", number(e, "id"))
                                .put("name", string(e, "name")).put("sets", number(e, "sets")).put("reps", string(e, "reps"))
                                .put("weight", e.getDouble(e.getColumnIndexOrThrow("weight"))).put("rest", number(e, "rest")).put("notes", string(e, "notes")));
                    }
                    workouts.put(workout.put("exercises", exercises));
                }
            }
            JSONArray sessions = new JSONArray();
            try (Cursor s = db.query("sessions", null, null, null, null, null, "completed_at DESC,id DESC")) {
                while (s.moveToNext()) sessions.put(new JSONObject().put("id", number(s, "id"))
                        .put("workoutId", s.isNull(s.getColumnIndexOrThrow("workout_id")) ? JSONObject.NULL : number(s, "workout_id"))
                        .put("workoutName", string(s, "workout_name")).put("completedAt", number(s, "completed_at"))
                        .put("volume", s.getDouble(s.getColumnIndexOrThrow("volume"))).put("duration", number(s, "duration")));
            }
            db.setTransactionSuccessful();
            return new JSONObject().put("ok", true).put("schemaVersion", DATABASE_VERSION).put("workouts", workouts).put("sessions", sessions);
        } finally { db.endTransaction(); }
    }

    /** Validates every exercise before opening the write transaction. */
    public synchronized JSONObject saveWorkout(JSONObject input) throws JSONException {
        String name = text(input, "name", 100, true);
        String focus = text(input, "focus", 100, false);
        String days = text(input, "days", 140, false);
        String notes = text(input, "notes", 2000, false);
        // The form sends id:0 for a new ficha; omitted/null IDs also mean create.
        long id = input.has("id") && !input.isNull("id") ? identifier(input, "id", 0) : 0;
        JSONArray inputExercises = input.optJSONArray("exercises");
        if (inputExercises == null || inputExercises.length() == 0) throw invalid("Adicione pelo menos um exercício.");
        if (inputExercises.length() > 100) throw invalid("Uma ficha pode ter até 100 exercícios.");
        List<ContentValues> exercises = new ArrayList<>();
        for (int i = 0; i < inputExercises.length(); i++) {
            JSONObject exercise = inputExercises.getJSONObject(i);
            ContentValues v = new ContentValues();
            v.put("name", text(exercise, "name", 120, true));
            v.put("sets", integer(exercise, "sets", 1, 100));
            v.put("reps", text(exercise, "reps", 40, true));
            v.put("weight", decimal(exercise, "weight", 0, 2000));
            v.put("rest", exercise.has("rest") ? integer(exercise, "rest", 0, 3600) : 60);
            v.put("notes", text(exercise, "notes", 1000, false));
            v.put("position", i);
            exercises.add(v);
        }
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            ContentValues values = new ContentValues();
            values.put("name", name); values.put("focus", focus); values.put("days", days); values.put("notes", notes);
            values.put("updated_at", System.currentTimeMillis());
            if (id == 0) {
                values.put("created_at", System.currentTimeMillis());
                id = db.insertOrThrow("workouts", null, values);
            } else {
                if (db.update("workouts", values, "id=?", new String[]{Long.toString(id)}) != 1) throw invalid("A ficha não foi encontrada.");
                db.delete("exercises", "workout_id=?", new String[]{Long.toString(id)});
            }
            for (ContentValues exercise : exercises) { exercise.put("workout_id", id); db.insertOrThrow("exercises", null, exercise); }
            db.setTransactionSuccessful();
            return success().put("id", id);
        } finally { db.endTransaction(); }
    }

    public synchronized JSONObject deleteWorkout(long id) throws JSONException {
        if (id <= 0) throw invalid("Ficha inválida.");
        if (getWritableDatabase().delete("workouts", "id=?", new String[]{Long.toString(id)}) != 1) throw invalid("A ficha não foi encontrada.");
        return success();
    }

    public synchronized JSONObject updateWeight(long exerciseId, double weight) throws JSONException {
        if (exerciseId <= 0) throw invalid("Exercício inválido.");
        if (Double.isNaN(weight) || Double.isInfinite(weight) || weight < 0 || weight > 2000) throw invalid("Informe uma carga entre 0 e 2.000 kg.");
        ContentValues values = new ContentValues(); values.put("weight", weight);
        if (getWritableDatabase().update("exercises", values, "id=?", new String[]{Long.toString(exerciseId)}) != 1) throw invalid("O exercício não foi encontrado. Abra a ficha novamente.");
        return success();
    }

    /** Duration is in seconds; volume estimates range-based reps using their lower bound. */
    public synchronized JSONObject finishWorkout(JSONObject input) throws JSONException {
        long workoutId = positiveId(input, "workoutId");
        // A resumed session can cross midnight or remain open for several days.
        int duration = integer(input, "duration", 0, Integer.MAX_VALUE);
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            String workoutName;
            try (Cursor w = db.query("workouts", new String[]{"name"}, "id=?", new String[]{Long.toString(workoutId)}, null, null, null)) {
                if (!w.moveToFirst()) throw invalid("A ficha não foi encontrada.");
                workoutName = w.getString(0);
            }
            double volume = 0;
            try (Cursor e = db.query("exercises", new String[]{"sets", "reps", "weight"}, "workout_id=?", new String[]{Long.toString(workoutId)}, null, null, null)) {
                while (e.moveToNext()) {
                    Matcher m = FIRST_REPETITIONS.matcher(e.getString(1));
                    if (m.find()) volume += e.getInt(0) * Integer.parseInt(m.group(1)) * e.getDouble(2);
                }
            }
            ContentValues values = new ContentValues(); values.put("workout_id", workoutId); values.put("workout_name", workoutName);
            values.put("completed_at", System.currentTimeMillis()); values.put("volume", volume); values.put("duration", duration);
            long id = db.insertOrThrow("sessions", null, values);
            db.setTransactionSuccessful();
            return success().put("id", id).put("volume", volume);
        } finally { db.endTransaction(); }
    }

    private static JSONObject success() throws JSONException { return new JSONObject().put("ok", true); }
    private static IllegalArgumentException invalid(String message) { return new IllegalArgumentException(message); }
    private static String string(Cursor cursor, String column) { return cursor.getString(cursor.getColumnIndexOrThrow(column)); }
    private static long number(Cursor cursor, String column) { return cursor.getLong(cursor.getColumnIndexOrThrow(column)); }

    private static String text(JSONObject object, String key, int max, boolean required) throws JSONException {
        Object raw = object.opt(key);
        if ((raw == null || raw == JSONObject.NULL) && !required) return "";
        // Repetitions may arrive as a number from a numeric input; store its text representation.
        if (!(raw instanceof String) && !("reps".equals(key) && raw instanceof Number)) throw invalid("Preencha corretamente o campo " + key + ".");
        String result = raw.toString().trim();
        if (required && result.isEmpty()) throw invalid("Preencha o campo " + ("name".equals(key) ? "nome" : key) + ".");
        if (result.length() > max) throw invalid("O campo " + key + " excede " + max + " caracteres.");
        return result;
    }

    private static double decimal(JSONObject object, String key, double min, double max) throws JSONException {
        Object raw = object.opt(key);
        if (!(raw instanceof Number) && !(raw instanceof String)) throw invalid("Informe um número válido em " + key + ".");
        double value;
        try { value = Double.parseDouble(raw.toString().replace(',', '.')); }
        catch (NumberFormatException e) { throw invalid("Informe um número válido em " + key + "."); }
        if (Double.isInfinite(value) || Double.isNaN(value) || value < min || value > max) throw invalid("Valor fora do intervalo permitido em " + key + ".");
        return value;
    }

    private static int integer(JSONObject object, String key, int min, int max) throws JSONException {
        double value = decimal(object, key, min, max);
        if (value != Math.rint(value)) throw invalid("Use um número inteiro em " + key + ".");
        return (int) value;
    }

    private static long positiveId(JSONObject object, String key) throws JSONException {
        return identifier(object, key, 1);
    }

    private static long identifier(JSONObject object, String key, int min) throws JSONException {
        double value = decimal(object, key, min, 9007199254740991d);
        if (value != Math.rint(value)) throw invalid("Identificador inválido.");
        return (long) value;
    }
}
