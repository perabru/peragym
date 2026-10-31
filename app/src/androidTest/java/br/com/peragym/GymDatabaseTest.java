package br.com.peragym;

import android.database.Cursor;
import android.test.AndroidTestCase;
import org.json.JSONArray;
import org.json.JSONObject;

/** Runs on Android's real SQLite engine, independent of the presentation layer. */
public final class GymDatabaseTest extends AndroidTestCase {
    private static final String TEST_DATABASE = "peragym-instrumentation-test.db";
    private GymDatabase database;

    @Override protected void setUp() throws Exception {
        super.setUp();
        getContext().deleteDatabase(TEST_DATABASE);
        database = new GymDatabase(getContext(), TEST_DATABASE);
    }

    @Override protected void tearDown() throws Exception {
        if (database != null) database.close();
        getContext().deleteDatabase(TEST_DATABASE);
        super.tearDown();
    }

    private JSONObject workout(String name, double weight) throws Exception {
        return new JSONObject().put("name", name).put("focus", "Peito e tríceps").put("days", "Segunda, quinta")
                .put("notes", "Ficha de teste")
                .put("exercises", new JSONArray().put(new JSONObject().put("name", "Supino reto")
                        .put("sets", 3).put("reps", "10").put("weight", weight).put("rest", 60).put("notes", "")));
    }

    private JSONObject onlyWorkout() throws Exception { return database.loadData().getJSONArray("workouts").getJSONObject(0); }

    public void testStartsEmptyWithoutInventedUserData() throws Exception {
        JSONObject data = database.loadData();
        assertTrue(data.getBoolean("ok"));
        assertEquals(0, data.getJSONArray("workouts").length());
        assertEquals(0, data.getJSONArray("sessions").length());
    }

    public void testNewFormAcceptsExplicitZeroIdAndDoesNotOverwrite() throws Exception {
        long firstId = database.saveWorkout(workout("Ficha A", 10).put("id", 0)).getLong("id");
        long secondId = database.saveWorkout(workout("Ficha B", 15).put("id", 0)).getLong("id");
        assertTrue(firstId > 0);
        assertTrue(secondId > firstId);
        assertEquals(2, database.loadData().getJSONArray("workouts").length());
        try { database.saveWorkout(workout("Inválida", 10).put("id", -1)); fail("Negative ID accepted"); }
        catch (IllegalArgumentException expected) { }
        assertEquals(2, database.loadData().getJSONArray("workouts").length());
    }

    public void testCreateEditAndPersistWorkoutWithDecimalWeight() throws Exception {
        long id = database.saveWorkout(workout("Treino A", 22.5)).getLong("id");
        JSONObject saved = onlyWorkout();
        assertEquals(id, saved.getLong("id"));
        assertEquals(22.5, saved.getJSONArray("exercises").getJSONObject(0).getDouble("weight"), 0.000001);
        saved.put("name", "Treino A atualizado");
        saved.getJSONArray("exercises").getJSONObject(0).put("weight", "27,25");
        database.saveWorkout(saved);
        database.close();
        database = new GymDatabase(getContext(), TEST_DATABASE);
        saved = onlyWorkout();
        assertEquals("Treino A atualizado", saved.getString("name"));
        assertEquals("Segunda, quinta", saved.getString("days"));
        assertEquals(27.25, saved.getJSONArray("exercises").getJSONObject(0).getDouble("weight"), 0.000001);
        assertEquals(1, database.loadData().getJSONArray("workouts").length());
    }

    public void testChangeWeightPersistsAndSupportsBodyweight() throws Exception {
        database.saveWorkout(workout("Ficha", 20));
        long exerciseId = onlyWorkout().getJSONArray("exercises").getJSONObject(0).getLong("id");
        database.updateWeight(exerciseId, 12.75);
        assertEquals(12.75, onlyWorkout().getJSONArray("exercises").getJSONObject(0).getDouble("weight"), 0.000001);
        database.updateWeight(exerciseId, 0);
        assertEquals(0.0, onlyWorkout().getJSONArray("exercises").getJSONObject(0).getDouble("weight"), 0.000001);
    }

    public void testDeleteCascadesExercisesAndPreservesCompletedHistory() throws Exception {
        long id = database.saveWorkout(workout("Ficha concluída", 20)).getLong("id");
        database.finishWorkout(new JSONObject().put("workoutId", id).put("duration", 600));
        database.deleteWorkout(id);
        JSONObject data = database.loadData();
        assertEquals(0, data.getJSONArray("workouts").length());
        try (Cursor c = database.getReadableDatabase().rawQuery("SELECT COUNT(*) FROM exercises", null)) {
            assertTrue(c.moveToFirst());
            assertEquals(0, c.getInt(0));
        }
        JSONObject session = data.getJSONArray("sessions").getJSONObject(0);
        assertTrue(session.isNull("workoutId"));
        assertEquals("Ficha concluída", session.getString("workoutName"));
        assertEquals(600, session.getInt("duration"));
        assertEquals(600.0, session.getDouble("volume"), 0.000001);
    }

    public void testInvalidEditDoesNotPartiallyOverwriteExistingData() throws Exception {
        database.saveWorkout(workout("Original", 30));
        JSONObject edited = onlyWorkout().put("name", "Inválida");
        edited.getJSONArray("exercises").getJSONObject(0).put("weight", -1);
        try { database.saveWorkout(edited); fail("Negative weights must be rejected"); }
        catch (IllegalArgumentException expected) { }
        assertEquals("Original", onlyWorkout().getString("name"));
        assertEquals(30.0, onlyWorkout().getJSONArray("exercises").getJSONObject(0).getDouble("weight"), 0.000001);
    }

    public void testRejectsInvalidWeightsAndMissingRows() throws Exception {
        database.saveWorkout(workout("Ficha", 15));
        long exerciseId = onlyWorkout().getJSONArray("exercises").getJSONObject(0).getLong("id");
        for (double weight : new double[]{-1, 2001, Double.NaN, Double.POSITIVE_INFINITY}) {
            try { database.updateWeight(exerciseId, weight); fail("Invalid weight accepted: " + weight); }
            catch (IllegalArgumentException expected) { }
        }
        try { database.updateWeight(999999, 10); fail("Missing exercise accepted"); }
        catch (IllegalArgumentException expected) { }
        try { database.deleteWorkout(999999); fail("Missing workout accepted"); }
        catch (IllegalArgumentException expected) { }
        assertEquals(15.0, onlyWorkout().getJSONArray("exercises").getJSONObject(0).getDouble("weight"), 0.000001);
    }

    public void testRejectsBlankNamesEmptyExercisesAndFractionalSets() throws Exception {
        try { database.saveWorkout(workout(" ", 10)); fail("Blank name accepted"); }
        catch (IllegalArgumentException expected) { }
        try { database.saveWorkout(workout("Ficha", 10).put("exercises", new JSONArray())); fail("Empty exercises accepted"); }
        catch (IllegalArgumentException expected) { }
        JSONObject fractional = workout("Ficha", 10);
        fractional.getJSONArray("exercises").getJSONObject(0).put("sets", 2.5);
        try { database.saveWorkout(fractional); fail("Fractional sets accepted"); }
        catch (IllegalArgumentException expected) { }
        assertEquals(0, database.loadData().getJSONArray("workouts").length());
    }

    public void testFinishingWorkoutUsesCurrentWeightAndRecordsTimestamp() throws Exception {
        long id = database.saveWorkout(workout("Treino B", 10)).getLong("id");
        long exerciseId = onlyWorkout().getJSONArray("exercises").getJSONObject(0).getLong("id");
        database.updateWeight(exerciseId, 12.5);
        long before = System.currentTimeMillis();
        database.finishWorkout(new JSONObject().put("workoutId", id).put("duration", 150));
        JSONObject session = database.loadData().getJSONArray("sessions").getJSONObject(0);
        assertEquals(375.0, session.getDouble("volume"), 0.000001);
        assertEquals(150, session.getInt("duration"));
        assertTrue(session.getLong("completedAt") >= before);
        assertEquals(id, session.getLong("workoutId"));
    }

    public void testResumedSessionCanFinishAfterTwentyFourHours() throws Exception {
        long id = database.saveWorkout(workout("Ficha retomada", 10).put("id", 0)).getLong("id");
        database.finishWorkout(new JSONObject().put("workoutId", id).put("duration", 172805));
        assertEquals(172805, database.loadData().getJSONArray("sessions").getJSONObject(0).getInt("duration"));
        try { database.finishWorkout(new JSONObject().put("workoutId", id).put("duration", -1)); fail("Negative duration accepted"); }
        catch (IllegalArgumentException expected) { }
        assertEquals(1, database.loadData().getJSONArray("sessions").length());
    }

    public void testEditingExerciseListRemovesOldExercises() throws Exception {
        database.saveWorkout(workout("Ficha", 10));
        JSONObject edited = onlyWorkout();
        edited.getJSONArray("exercises").put(new JSONObject().put("name", "Crucifixo").put("sets", 2).put("reps", "8–12").put("weight", 5).put("rest", 45));
        database.saveWorkout(edited);
        assertEquals(2, onlyWorkout().getJSONArray("exercises").length());
        edited = onlyWorkout();
        edited.put("exercises", new JSONArray().put(edited.getJSONArray("exercises").getJSONObject(1)));
        database.saveWorkout(edited);
        assertEquals(1, onlyWorkout().getJSONArray("exercises").length());
        assertEquals("Crucifixo", onlyWorkout().getJSONArray("exercises").getJSONObject(0).getString("name"));
    }
}
